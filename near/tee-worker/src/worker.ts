import {
  base64UrlToBytes,
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  canonicalizeTerms,
  createDepositCommitment,
  decryptJsonEnvelope,
  domainSeparatedHash,
  encryptJsonForRecipient,
  utf8,
  verifySignedTerms,
  verifySignedWorkerAction,
  type EncryptedEnvelopeV1,
  type SignedTermsV1,
  type SignedWorkerActionV1,
  type WorkerAction,
} from "@air-otc/shared-types";
import { WorkerError, asWorkerError } from "./errors.js";
import { Mutex } from "./mutex.js";
import { addAtomic, balanceFor, createEmptyState, ledgerRoot, subtractAtomic, validateState } from "./state.js";
import type {
  Clock,
  ContractGateway,
  IdentityVerifier,
  LedgerStateV1,
  PrivateDeal,
  PrivateWithdrawal,
  StateStore,
} from "./types.js";

export const TERMS_REQUEST_CONTEXT = "airotc:terms-submission:v1";
export const ACTION_REQUEST_CONTEXT = "airotc:worker-action:v1";
export const WORKER_RESPONSE_CONTEXT = "airotc:worker-response:v1";
export const WITHDRAWAL_POLICY_DOMAIN = "airotc:withdrawal-policy:v1";
const MAX_REQUEST_LIFETIME_NS = 24n * 60n * 60n * 1_000_000_000n;

export interface ConfidentialWorkerOptions {
  workerId: string;
  encryptionKeyId: string;
  encryptionSecretKey: Uint8Array;
  stateStore: StateStore;
  contract: ContractGateway;
  identityVerifier: IdentityVerifier;
  clock: Clock;
  anchorMode?: "IMMEDIATE" | "BATCHED";
}

interface OperationResult {
  result: Record<string, unknown>;
  anchor: boolean;
  withdrawalId?: string;
}

export class ConfidentialWorker {
  private readonly mutex = new Mutex();
  private state: LedgerStateV1 = createEmptyState();
  private initialized = false;

  constructor(private readonly options: ConfidentialWorkerOptions) {
    if (options.encryptionSecretKey.length !== 32) throw new Error("TEE encryption secret key must be 32 bytes");
    if (!/^[a-z0-9._-]{2,64}$/.test(options.workerId)) throw new Error("workerId has an invalid format");
    if (!/^[A-Za-z0-9:._-]{3,128}$/.test(options.encryptionKeyId)) {
      throw new Error("encryptionKeyId has an invalid format");
    }
  }

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      const loaded = await this.options.stateStore.load();
      this.state = loaded === null ? createEmptyState() : validateState(loaded);
      this.initialized = true;
      await this.reconcileAnchor();
      await this.reconcileWithdrawals();
      await this.anchorPending();
    });
  }

  identity(): { workerId: string; encryptionKeyId: string; encryptionPublicKey: string } {
    return {
      workerId: this.options.workerId,
      encryptionKeyId: this.options.encryptionKeyId,
      encryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(this.options.encryptionSecretKey)),
    };
  }

  async handleTermsEnvelope(envelope: EncryptedEnvelopeV1): Promise<EncryptedEnvelopeV1> {
    this.requireInitialized();
    const signed = decryptJsonEnvelope<SignedTermsV1>({
      envelope,
      recipientSecretKey: this.options.encryptionSecretKey,
      expectedKeyId: this.options.encryptionKeyId,
      expectedContext: TERMS_REQUEST_CONTEXT,
    });
    let response: Record<string, unknown>;
    try {
      response = { ok: true, ...(await this.submitTerms(signed)) };
    } catch (error) {
      const workerError = asWorkerError(error);
      response = { ok: false, error: { code: workerError.code, message: workerError.message } };
    }
    return encryptResponse(response, signed.replyPublicKey, signed.replyKeyId);
  }

  async handleActionEnvelope(envelope: EncryptedEnvelopeV1, withdrawalAmountCommitment?: string): Promise<EncryptedEnvelopeV1> {
    this.requireInitialized();
    const signed = decryptJsonEnvelope<SignedWorkerActionV1>({
      envelope,
      recipientSecretKey: this.options.encryptionSecretKey,
      expectedKeyId: this.options.encryptionKeyId,
      expectedContext: ACTION_REQUEST_CONTEXT,
    });
    let response: Record<string, unknown>;
    try {
      if (signed.action.type === "REQUEST_WITHDRAWAL") {
        const expected = domainSeparatedHash(WITHDRAWAL_POLICY_DOMAIN, utf8(signed.action.amountAtomic));
        if (withdrawalAmountCommitment !== expected) {
          throw new WorkerError("WITHDRAWAL_POLICY_MISMATCH", "Withdrawal amount does not match the authorized policy amount", 403);
        }
      } else if (withdrawalAmountCommitment !== undefined) {
        throw new WorkerError("UNEXPECTED_WITHDRAWAL_POLICY", "Withdrawal policy is not valid for this action", 400);
      }
      response = { ok: true, ...(await this.executeAction(signed)) };
    } catch (error) {
      const workerError = asWorkerError(error);
      response = { ok: false, error: { code: workerError.code, message: workerError.message } };
    }
    return encryptResponse(response, signed.replyPublicKey, signed.replyKeyId);
  }

  async submitTerms(value: unknown): Promise<Record<string, unknown>> {
    return this.mutex.run(async () => {
      const signed = verifySignedTerms(value);
      await this.verifyIdentity(signed.signerId, signed.publicKey);
      this.requireFresh(BigInt(signed.terms.expiresAtNs));
      const nonceKey = this.nonceKey(signed.signerId, signed.submissionNonce);
      this.requireUnusedNonce(nonceKey);
      this.state.usedNonces[nonceKey] = this.options.clock.nowNs().toString();

      const ticketId = signed.terms.ticketId;
      const existingDeal = this.state.deals[ticketId];
      if (existingDeal) {
        await this.persist(false);
        throw new WorkerError("DEAL_ALREADY_MATCHED", "This ticket already has matched terms", 409);
      }

      let round = this.state.termRounds[ticketId];
      if (!round || round.status === "NO_MATCH") {
        round = {
          round: (round?.round ?? 0) + 1,
          status: "WAITING",
          updatedAtNs: this.options.clock.nowNs().toString(),
        };
        this.state.termRounds[ticketId] = round;
      }
      const slot = signed.role === "BUYER" ? "buyer" : "seller";
      if (round[slot]) {
        await this.persist(false);
        throw new WorkerError("ROLE_ALREADY_SUBMITTED", "This role already submitted terms for the current round", 409);
      }
      round[slot] = signed;
      round.updatedAtNs = this.options.clock.nowNs().toString();

      if (!round.buyer || !round.seller) {
        await this.persist(false);
        return { status: "WAITING_FOR_COUNTERPARTY", round: round.round };
      }

      if (
        round.buyer.termsHash !== round.seller.termsHash ||
        canonicalizeTerms(round.buyer.terms) !== canonicalizeTerms(round.seller.terms)
      ) {
        round.status = "NO_MATCH";
        await this.persist(false);
        return { status: "NO_MATCH", round: round.round };
      }

      round.status = "MATCHED";
      const terms = round.buyer.terms;
      const deal: PrivateDeal = {
        ticketId,
        termsHash: round.buyer.termsHash,
        terms,
        status: "MATCHED_AWAITING_BALANCE",
        buyerLockedAtomic: addAtomic(terms.priceAtomic, terms.buyerCollateralAtomic),
        sellerLockedAtomic: terms.sellerCollateralAtomic,
        deliveryCommitment: "",
        buyerCancellation: false,
        sellerCancellation: false,
        fundedAtNs: "0",
        deliveredAtNs: "0",
        settledAtNs: "0",
      };
      this.state.deals[ticketId] = deal;
      const funded = this.tryFundDeal(deal);
      await this.persist(true);
      return {
        status: funded ? "MATCH" : "MATCH_AWAITING_BALANCE",
        round: round.round,
        termsHash: deal.termsHash,
        dealStatus: deal.status,
      };
    });
  }

  async executeAction(value: unknown): Promise<Record<string, unknown>> {
    return this.mutex.run(async () => {
      const signed = verifySignedWorkerAction(value);
      await this.verifyIdentity(signed.actorId, signed.publicKey);
      this.requireFresh(BigInt(signed.expiresAtNs));
      const nonceKey = this.nonceKey(signed.actorId, signed.nonce);
      this.requireUnusedNonce(nonceKey);
      this.state.usedNonces[nonceKey] = this.options.clock.nowNs().toString();

      let operation: OperationResult;
      try {
        operation = await this.applyAction(signed.actorId, signed.nonce, signed.expiresAtNs, signed.action);
      } catch (error) {
        await this.persist(false);
        throw error;
      }

      await this.persist(operation.anchor);
      if (operation.withdrawalId) {
        // A withdrawal must always reference the current on-chain root, even
        // when ordinary state transitions are being batched.
        await this.anchorPending();
        await this.executeWithdrawal(operation.withdrawalId);
        const withdrawal = this.state.withdrawals[operation.withdrawalId];
        operation.result.withdrawalStatus = withdrawal?.status ?? "PENDING";
        operation.result.transactionHash = withdrawal?.transactionHash ?? "";
      }
      return operation.result;
    });
  }

  snapshotForTesting(): LedgerStateV1 {
    return structuredClone(this.state);
  }

  async runMaintenance(): Promise<{ timedOutDeals: number; anchored: boolean }> {
    this.requireInitialized();
    return this.mutex.run(async () => {
      let timedOutDeals = 0;
      const now = this.options.clock.nowNs();
      for (const ticketId of Object.keys(this.state.deals).sort()) {
        const deal = this.state.deals[ticketId];
        if (deal && this.applyDueTimeout(deal, now)) timedOutDeals += 1;
      }

      if (timedOutDeals > 0) await this.persist(true);
      const anchorWasPending = this.state.ledgerSequence !== this.state.lastAnchoredSequence;
      await this.anchorPending();
      return {
        timedOutDeals,
        anchored: anchorWasPending || (timedOutDeals > 0 && this.options.anchorMode !== "BATCHED"),
      };
    });
  }

  private async applyAction(
    actorId: string,
    nonce: string,
    expiryNs: string,
    action: WorkerAction,
  ): Promise<OperationResult> {
    switch (action.type) {
      case "CLAIM_DEPOSIT":
        return this.claimDeposit(actorId, action.depositSecret);
      case "SUBMIT_DELIVERY":
        return this.submitDelivery(actorId, action.ticketId, action.deliveryCommitment);
      case "CONFIRM_DELIVERY":
        return this.confirmDelivery(actorId, action.ticketId);
      case "REQUEST_CANCELLATION":
        return this.requestCancellation(actorId, action.ticketId);
      case "PROCESS_TIMEOUT":
        return this.processTimeout(actorId, action.ticketId);
      case "GET_BALANCE": {
        const balance = balanceFor(this.state, actorId);
        return { result: { balance: { ...balance } }, anchor: false };
      }
      case "GET_DEAL_STATUS": {
        const deal = this.requireParty(actorId, action.ticketId);
        return {
          result: {
            deal: {
              ticketId: deal.ticketId,
              termsHash: deal.termsHash,
              status: deal.status,
              deliveryCommitment: deal.deliveryCommitment,
              fundedAtNs: deal.fundedAtNs,
              deliveredAtNs: deal.deliveredAtNs,
              settledAtNs: deal.settledAtNs,
            },
          },
          anchor: false,
        };
      }
      case "REQUEST_WITHDRAWAL":
        return this.requestWithdrawal(actorId, nonce, expiryNs, action.recipientId, action.amountAtomic);
    }
    throw new WorkerError("UNSUPPORTED_ACTION", "Unsupported worker action", 400);
  }

  private async claimDeposit(actorId: string, secret: string): Promise<OperationResult> {
    const commitment = createDepositCommitment(secret);
    if (this.state.claimedDeposits[commitment]) {
      throw new WorkerError("DEPOSIT_ALREADY_CLAIMED", "Deposit commitment has already been claimed", 409);
    }
    const deposit = await this.options.contract.getDeposit(commitment, actorId);
    if (!deposit || !deposit.finalized) throw new WorkerError("DEPOSIT_NOT_FINAL", "Deposit is not finalized", 404);
    if (deposit.depositorId !== actorId) {
      throw new WorkerError("DEPOSIT_IDENTITY_MISMATCH", "Deposit account does not match the signed identity", 403);
    }
    const balance = balanceFor(this.state, actorId);
    balance.availableAtomic = addAtomic(balance.availableAtomic, deposit.amountAtomic);
    this.state.claimedDeposits[commitment] = {
      accountId: actorId,
      amountAtomic: deposit.amountAtomic,
      claimedAtNs: this.options.clock.nowNs().toString(),
    };
    const newlyFunded: string[] = [];
    for (const ticketId of Object.keys(this.state.deals).sort()) {
      const deal = this.state.deals[ticketId];
      if (
        deal &&
        deal.status === "MATCHED_AWAITING_BALANCE" &&
        (deal.terms.buyerId === actorId || deal.terms.sellerId === actorId) &&
        this.tryFundDeal(deal)
      ) {
        newlyFunded.push(ticketId);
      }
    }
    return {
      result: {
        status: "DEPOSIT_CLAIMED",
        amountAtomic: deposit.amountAtomic,
        newlyFundedTickets: newlyFunded,
      },
      anchor: true,
    };
  }

  private submitDelivery(actorId: string, ticketId: string, deliveryCommitment: string): OperationResult {
    const deal = this.requireParty(actorId, ticketId);
    if (deal.terms.sellerId !== actorId) throw new WorkerError("SELLER_ONLY", "Only the seller can submit delivery", 403);
    if (deal.status !== "FUNDED") throw new WorkerError("DEAL_NOT_FUNDED", "Deal is not ready for delivery", 409);
    if (this.options.clock.nowNs() > BigInt(deal.terms.deliveryDeadlineNs)) {
      throw new WorkerError("DELIVERY_DEADLINE_PASSED", "Delivery deadline has passed", 409);
    }
    deal.deliveryCommitment = deliveryCommitment;
    deal.deliveredAtNs = this.options.clock.nowNs().toString();
    deal.status = "DELIVERED";
    return { result: { status: deal.status, deliveryCommitment }, anchor: true };
  }

  private confirmDelivery(actorId: string, ticketId: string): OperationResult {
    const deal = this.requireParty(actorId, ticketId);
    if (deal.terms.buyerId !== actorId) throw new WorkerError("BUYER_ONLY", "Only the buyer can confirm delivery", 403);
    if (deal.status !== "DELIVERED") throw new WorkerError("DELIVERY_NOT_RECORDED", "Delivery has not been recorded", 409);
    this.settleSuccessful(deal, "COMPLETED");
    return { result: { status: deal.status }, anchor: true };
  }

  private requestCancellation(actorId: string, ticketId: string): OperationResult {
    const deal = this.requireParty(actorId, ticketId);
    if (deal.status !== "FUNDED" && deal.status !== "MATCHED_AWAITING_BALANCE") {
      throw new WorkerError("CANCELLATION_UNAVAILABLE", "Deal can no longer be mutually cancelled", 409);
    }
    if (actorId === deal.terms.buyerId) deal.buyerCancellation = true;
    if (actorId === deal.terms.sellerId) deal.sellerCancellation = true;
    if (!deal.buyerCancellation || !deal.sellerCancellation) {
      return { result: { status: "WAITING_FOR_COUNTERPARTY_CANCELLATION" }, anchor: true };
    }
    const hadLockedFunds = deal.status === "FUNDED";
    if (hadLockedFunds) this.unlockDeal(deal);
    deal.status = "CANCELLED";
    deal.settledAtNs = this.options.clock.nowNs().toString();
    return { result: { status: deal.status }, anchor: true };
  }

  private processTimeout(actorId: string, ticketId: string): OperationResult {
    const deal = this.requireParty(actorId, ticketId);
    const now = this.options.clock.nowNs();
    if (this.applyDueTimeout(deal, now)) {
      return { result: { status: deal.status }, anchor: true };
    }
    throw new WorkerError("TIMEOUT_NOT_AVAILABLE", "No deal timeout is currently executable", 409);
  }

  private applyDueTimeout(deal: PrivateDeal, now: bigint): boolean {
    if (deal.status === "MATCHED_AWAITING_BALANCE" && now > BigInt(deal.terms.fundingDeadlineNs)) {
      deal.status = "CANCELLED";
      deal.settledAtNs = now.toString();
      return true;
    }
    if (deal.status === "FUNDED" && now > BigInt(deal.terms.deliveryDeadlineNs)) {
      const buyer = balanceFor(this.state, deal.terms.buyerId);
      const seller = balanceFor(this.state, deal.terms.sellerId);
      buyer.lockedAtomic = subtractAtomic(buyer.lockedAtomic, deal.buyerLockedAtomic);
      seller.lockedAtomic = subtractAtomic(seller.lockedAtomic, deal.sellerLockedAtomic);
      buyer.availableAtomic = addAtomic(
        buyer.availableAtomic,
        addAtomic(deal.buyerLockedAtomic, deal.sellerLockedAtomic),
      );
      deal.status = "SELLER_TIMEOUT";
      deal.settledAtNs = now.toString();
      return true;
    }
    if (deal.status === "DELIVERED" && now > BigInt(deal.terms.confirmationDeadlineNs)) {
      this.settleSuccessful(deal, "AUTO_RELEASED");
      return true;
    }
    return false;
  }

  private requestWithdrawal(
    actorId: string,
    nonce: string,
    expiryNs: string,
    recipientId: string,
    amountAtomic: string,
  ): OperationResult {
    const balance = balanceFor(this.state, actorId);
    if (BigInt(balance.availableAtomic) < BigInt(amountAtomic)) {
      throw new WorkerError("INSUFFICIENT_AVAILABLE_BALANCE", "Available private balance is insufficient", 409);
    }
    const withdrawalId = domainSeparatedHash(
      "airotc:withdrawal:v1",
      utf8(`${this.options.workerId}\0${actorId}\0${nonce}`),
    );
    if (this.state.withdrawals[withdrawalId]) {
      throw new WorkerError("WITHDRAWAL_ALREADY_EXISTS", "Withdrawal already exists", 409);
    }
    balance.availableAtomic = subtractAtomic(balance.availableAtomic, amountAtomic);
    const withdrawal: PrivateWithdrawal = {
      withdrawalId,
      accountId: actorId,
      recipientId,
      amountAtomic,
      expiryNs,
      ledgerRoot: "",
      status: "PENDING",
      createdAtNs: this.options.clock.nowNs().toString(),
      transactionHash: "",
    };
    this.state.withdrawals[withdrawalId] = withdrawal;
    return {
      result: { status: "WITHDRAWAL_PENDING", withdrawalId },
      anchor: true,
      withdrawalId,
    };
  }

  private tryFundDeal(deal: PrivateDeal): boolean {
    if (deal.status !== "MATCHED_AWAITING_BALANCE") return false;
    if (this.options.clock.nowNs() > BigInt(deal.terms.fundingDeadlineNs)) return false;
    const buyer = balanceFor(this.state, deal.terms.buyerId);
    const seller = balanceFor(this.state, deal.terms.sellerId);
    if (
      BigInt(buyer.availableAtomic) < BigInt(deal.buyerLockedAtomic) ||
      BigInt(seller.availableAtomic) < BigInt(deal.sellerLockedAtomic)
    ) {
      return false;
    }
    buyer.availableAtomic = subtractAtomic(buyer.availableAtomic, deal.buyerLockedAtomic);
    buyer.lockedAtomic = addAtomic(buyer.lockedAtomic, deal.buyerLockedAtomic);
    seller.availableAtomic = subtractAtomic(seller.availableAtomic, deal.sellerLockedAtomic);
    seller.lockedAtomic = addAtomic(seller.lockedAtomic, deal.sellerLockedAtomic);
    deal.status = "FUNDED";
    deal.fundedAtNs = this.options.clock.nowNs().toString();
    return true;
  }

  private settleSuccessful(deal: PrivateDeal, status: "COMPLETED" | "AUTO_RELEASED"): void {
    const buyer = balanceFor(this.state, deal.terms.buyerId);
    const seller = balanceFor(this.state, deal.terms.sellerId);
    buyer.lockedAtomic = subtractAtomic(buyer.lockedAtomic, deal.buyerLockedAtomic);
    seller.lockedAtomic = subtractAtomic(seller.lockedAtomic, deal.sellerLockedAtomic);
    buyer.availableAtomic = addAtomic(buyer.availableAtomic, deal.terms.buyerCollateralAtomic);
    seller.availableAtomic = addAtomic(
      seller.availableAtomic,
      addAtomic(deal.terms.priceAtomic, deal.terms.sellerCollateralAtomic),
    );
    deal.status = status;
    deal.settledAtNs = this.options.clock.nowNs().toString();
  }

  private unlockDeal(deal: PrivateDeal): void {
    const buyer = balanceFor(this.state, deal.terms.buyerId);
    const seller = balanceFor(this.state, deal.terms.sellerId);
    buyer.lockedAtomic = subtractAtomic(buyer.lockedAtomic, deal.buyerLockedAtomic);
    seller.lockedAtomic = subtractAtomic(seller.lockedAtomic, deal.sellerLockedAtomic);
    buyer.availableAtomic = addAtomic(buyer.availableAtomic, deal.buyerLockedAtomic);
    seller.availableAtomic = addAtomic(seller.availableAtomic, deal.sellerLockedAtomic);
  }

  private requireParty(actorId: string, ticketId: string): PrivateDeal {
    const deal = this.state.deals[ticketId];
    if (!deal) throw new WorkerError("DEAL_NOT_FOUND", "Private deal was not found", 404);
    if (actorId !== deal.terms.buyerId && actorId !== deal.terms.sellerId) {
      throw new WorkerError("DEAL_ACCESS_DENIED", "Caller is not a party to this deal", 403);
    }
    return deal;
  }

  private async executeWithdrawal(withdrawalId: string): Promise<void> {
    const withdrawal = this.state.withdrawals[withdrawalId];
    if (!withdrawal || withdrawal.status !== "PENDING") return;
    withdrawal.ledgerRoot = ledgerRoot(this.state);
    try {
      const result = await this.options.contract.withdraw({
        withdrawalId,
        recipientId: withdrawal.recipientId,
        amountAtomic: withdrawal.amountAtomic,
        expiryNs: withdrawal.expiryNs,
        ledgerRoot: withdrawal.ledgerRoot,
      });
      withdrawal.transactionHash = result.transactionHash;
      const chainRecord = await this.options.contract.getWithdrawal(withdrawalId);
      if (chainRecord?.status === "COMPLETED") withdrawal.status = "COMPLETED";
      await this.bumpAndSave();
    } catch (error) {
      await this.bumpAndSave();
      throw new WorkerError("WITHDRAWAL_PENDING", "Withdrawal is saved and awaiting contract reconciliation", 503);
    }
  }

  private async reconcileWithdrawals(): Promise<void> {
    for (const withdrawalId of Object.keys(this.state.withdrawals).sort()) {
      const withdrawal = this.state.withdrawals[withdrawalId];
      if (!withdrawal || withdrawal.status !== "PENDING") continue;
      const chainRecord = await this.options.contract.getWithdrawal(withdrawalId);
      if (chainRecord?.status === "COMPLETED") {
        withdrawal.status = "COMPLETED";
        withdrawal.transactionHash = chainRecord.transactionHash ?? withdrawal.transactionHash;
        await this.bumpAndSave();
        continue;
      }
      if (BigInt(withdrawal.expiryNs) <= this.options.clock.nowNs() || (chainRecord?.attempts ?? 0) >= 3) {
        const balance = balanceFor(this.state, withdrawal.accountId);
        balance.availableAtomic = addAtomic(balance.availableAtomic, withdrawal.amountAtomic);
        withdrawal.status = "FAILED";
        await this.persist(true);
        continue;
      }
      if (chainRecord === null || chainRecord.status === "FAILED") {
        try {
          await this.executeWithdrawal(withdrawalId);
        } catch (error) {
          if (!(error instanceof WorkerError) || error.code !== "WITHDRAWAL_PENDING") throw error;
        }
      }
    }
  }

  private async persist(anchor: boolean): Promise<void> {
    this.state.revision = (BigInt(this.state.revision) + 1n).toString();
    if (!anchor) {
      await this.options.stateStore.save(this.state);
      return;
    }
    this.state.ledgerSequence = (BigInt(this.state.ledgerSequence) + 1n).toString();
    await this.options.stateStore.save(this.state);
    if (this.options.anchorMode === "BATCHED") return;
    await this.anchorPending();
  }

  private async anchorPending(): Promise<boolean> {
    if (this.state.ledgerSequence === this.state.lastAnchoredSequence) return false;
    try {
      const root = ledgerRoot(this.state);
      await this.options.contract.anchorLedgerRoot(root, this.state.ledgerSequence);
      this.state.lastAnchoredSequence = this.state.ledgerSequence;
      this.state.lastAnchoredRoot = root;
      await this.options.stateStore.save(this.state);
      return true;
    } catch {
      throw new WorkerError("LEDGER_ANCHOR_PENDING", "Private state is saved but its ledger root is awaiting retry", 503);
    }
  }

  private async bumpAndSave(): Promise<void> {
    this.state.revision = (BigInt(this.state.revision) + 1n).toString();
    await this.options.stateStore.save(this.state);
  }

  private async reconcileAnchor(): Promise<void> {
    const chain = await this.options.contract.getLedgerAnchor();
    const chainSequence = BigInt(chain.sequence);
    const ledgerSequence = BigInt(this.state.ledgerSequence);
    const lastAnchoredSequence = BigInt(this.state.lastAnchoredSequence);
    if (chainSequence > ledgerSequence) {
      throw new WorkerError("SNAPSHOT_ROLLBACK", "Encrypted snapshot is older than the on-chain ledger anchor", 503);
    }
    if (chainSequence < lastAnchoredSequence) {
      throw new WorkerError("ANCHOR_ROLLBACK", "On-chain ledger anchor is older than the encrypted snapshot", 503);
    }
    if (chainSequence === lastAnchoredSequence && chain.root !== this.state.lastAnchoredRoot) {
      throw new WorkerError("ANCHOR_MISMATCH", "On-chain ledger root does not match the encrypted snapshot", 503);
    }
    if (chainSequence !== lastAnchoredSequence && chainSequence !== ledgerSequence) {
      throw new WorkerError("ANCHOR_SEQUENCE_MISMATCH", "On-chain ledger sequence is inconsistent with the snapshot", 503);
    }
    const root = ledgerRoot(this.state);
    if (chainSequence === ledgerSequence) {
      if (ledgerSequence > 0n && chain.root !== root) {
        throw new WorkerError("ANCHOR_MISMATCH", "On-chain ledger root does not match the encrypted snapshot", 503);
      }
      this.state.lastAnchoredSequence = this.state.ledgerSequence;
      this.state.lastAnchoredRoot = chain.root;
      await this.options.stateStore.save(this.state);
      return;
    }
    await this.options.contract.anchorLedgerRoot(root, this.state.ledgerSequence);
    this.state.lastAnchoredSequence = this.state.ledgerSequence;
    this.state.lastAnchoredRoot = root;
    await this.options.stateStore.save(this.state);
  }

  private async verifyIdentity(accountId: string, publicKey: string): Promise<void> {
    if (!(await this.options.identityVerifier.isAuthorizedKey(accountId, publicKey))) {
      throw new WorkerError("UNAUTHORIZED_ACCOUNT_KEY", "Signing key is not authorized for this NEAR account", 403);
    }
  }

  private requireFresh(expiry: bigint): void {
    const now = this.options.clock.nowNs();
    if (expiry <= now) throw new WorkerError("REQUEST_EXPIRED", "Signed request has expired", 409);
    if (expiry - now > MAX_REQUEST_LIFETIME_NS) {
      throw new WorkerError("EXPIRY_TOO_DISTANT", "Signed request lifetime exceeds 24 hours", 400);
    }
  }

  private nonceKey(accountId: string, nonce: string): string {
    return `${accountId}:${nonce}`;
  }

  private requireUnusedNonce(key: string): void {
    if (this.state.usedNonces[key]) throw new WorkerError("NONCE_REPLAY", "Signed nonce was already used", 409);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new WorkerError("WORKER_NOT_READY", "Worker has not initialized", 503);
  }
}

function encryptResponse(
  response: Record<string, unknown>,
  replyPublicKey: string,
  replyKeyId: string,
): EncryptedEnvelopeV1 {
  return encryptJsonForRecipient({
    payload: response,
    recipientPublicKey: base64UrlToBytes(replyPublicKey),
    recipientKeyId: replyKeyId,
    context: WORKER_RESPONSE_CONTEXT,
  });
}

export class SystemClock implements Clock {
  nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }
}

