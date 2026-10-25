import { describe, expect, it } from "vitest";
import {
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  createDepositCommitment,
  decryptJsonEnvelope,
  domainSeparatedHash,
  encryptJsonForRecipient,
  publicKeyFromSeed,
  signTerms,
  signWorkerAction,
  type FinalTermsV1,
  type WorkerAction,
  utf8,
} from "@air-otc/shared-types";
import { MemoryContractGateway } from "../src/contract-gateway.js";
import { StaticIdentityVerifier } from "../src/identity.js";
import { MemoryStateStore } from "../src/snapshot-store.js";
import type { Clock } from "../src/types.js";
import {
  ACTION_REQUEST_CONTEXT,
  ConfidentialWorker,
  TERMS_REQUEST_CONTEXT,
  WORKER_RESPONSE_CONTEXT,
  WITHDRAWAL_POLICY_DOMAIN,
} from "../src/worker.js";

const buyerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const sellerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const outsiderSeed = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const buyerReplySecret = Uint8Array.from({ length: 32 }, (_, index) => index + 65);
const sellerReplySecret = Uint8Array.from({ length: 32 }, (_, index) => index + 97);
const teeSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const buyerPublicKey = publicKeyFromSeed(buyerSeed);
const sellerPublicKey = publicKeyFromSeed(sellerSeed);
const outsiderPublicKey = publicKeyFromSeed(outsiderSeed);
const buyerReplyPublicKey = bytesToBase64Url(boxPublicKeyFromSecret(buyerReplySecret));
const sellerReplyPublicKey = bytesToBase64Url(boxPublicKeyFromSecret(sellerReplySecret));

class TestClock implements Clock {
  constructor(public value: bigint) {}
  nowNs(): bigint {
    return this.value;
  }
}

function terms(clock: TestClock, overrides: Partial<FinalTermsV1> = {}): FinalTermsV1 {
  return {
    version: 1,
    ticketId: "ticket_01JTEEWORKER000001",
    buyerId: "buyer.testnet",
    sellerId: "seller.testnet",
    assetDescriptionHash: "61aaf7411dc22392b475ac0f71a59c5ca6c2e3595b2e7741413f78f3912d2df1",
    currency: "NEAR_TESTNET",
    priceAtomic: "500",
    buyerCollateralAtomic: "100",
    sellerCollateralAtomic: "200",
    fundingDeadlineNs: (clock.value + 10_000_000_000_000n).toString(),
    deliveryDeadlineNs: (clock.value + 20_000_000_000_000n).toString(),
    confirmationDeadlineNs: (clock.value + 30_000_000_000_000n).toString(),
    sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
    buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
    nonce: "agreement_nonce_000000000001",
    expiresAtNs: (clock.value + 1_000_000_000_000n).toString(),
    ...overrides,
  };
}

function environment(anchorMode: "IMMEDIATE" | "BATCHED" = "IMMEDIATE") {
  const clock = new TestClock(1_800_000_000_000_000_000n);
  const store = new MemoryStateStore();
  const contract = new MemoryContractGateway();
  const identities = new StaticIdentityVerifier(
    new Map([
      ["buyer.testnet", new Set([buyerPublicKey])],
      ["seller.testnet", new Set([sellerPublicKey])],
      ["outsider.testnet", new Set([outsiderPublicKey])],
    ]),
  );
  const createWorker = () =>
    new ConfidentialWorker({
      workerId: "tee-worker.testnet",
      encryptionKeyId: "tee-key-v1",
      encryptionSecretKey: teeSecret,
      stateStore: store,
      contract,
      identityVerifier: identities,
      clock,
      anchorMode,
    });
  return { clock, store, contract, createWorker };
}

function signedTerms(role: "BUYER" | "SELLER", value: FinalTermsV1, submissionNonce: string) {
  const buyer = role === "BUYER";
  return signTerms({
    terms: value,
    role,
    signerId: buyer ? value.buyerId : value.sellerId,
    replyKeyId: buyer ? "buyer-reply-v1" : "seller-reply-v1",
    replyPublicKey: buyer ? buyerReplyPublicKey : sellerReplyPublicKey,
    submissionNonce,
    signingSeed: buyer ? buyerSeed : sellerSeed,
  });
}

let actionSequence = 0;
function signedAction(actor: "BUYER" | "SELLER" | "OUTSIDER", clock: TestClock, action: WorkerAction, nonce?: string) {
  actionSequence += 1;
  const buyer = actor === "BUYER";
  const outsider = actor === "OUTSIDER";
  const seed = buyer ? buyerSeed : outsider ? outsiderSeed : sellerSeed;
  return signWorkerAction({
    actorId: buyer ? "buyer.testnet" : outsider ? "outsider.testnet" : "seller.testnet",
    publicKey: buyer ? buyerPublicKey : outsider ? outsiderPublicKey : sellerPublicKey,
    replyKeyId: buyer ? "buyer-reply-v1" : "seller-reply-v1",
    replyPublicKey: buyer ? buyerReplyPublicKey : sellerReplyPublicKey,
    nonce: nonce ?? `action_nonce_${actionSequence.toString().padStart(16, "0")}`,
    expiresAtNs: (clock.value + 1_000_000_000_000n).toString(),
    action,
    signingSeed: seed,
  });
}

async function claimDeposit(
  worker: ConfidentialWorker,
  contract: MemoryContractGateway,
  clock: TestClock,
  actor: "BUYER" | "SELLER",
  amountAtomic: string,
  secretByte: number,
) {
  const secret = bytesToBase64Url(new Uint8Array(32).fill(secretByte));
  const commitment = createDepositCommitment(secret);
  contract.deposits.set(commitment, {
    commitment,
    depositorId: actor === "BUYER" ? "buyer.testnet" : "seller.testnet",
    amountAtomic,
    finalized: true,
  });
  return worker.executeAction(signedAction(actor, clock, { type: "CLAIM_DEPOSIT", depositSecret: secret }));
}

async function matchAndFund(
  worker: ConfidentialWorker,
  contract: MemoryContractGateway,
  clock: TestClock,
  value: FinalTermsV1,
) {
  await worker.submitTerms(signedTerms("BUYER", value, "buyer_submission_nonce_0001"));
  await worker.submitTerms(signedTerms("SELLER", value, "seller_submission_nonce_001"));
  await claimDeposit(worker, contract, clock, "BUYER", "700", 7);
  await claimDeposit(worker, contract, clock, "SELLER", "300", 9);
}

describe("deterministic confidential worker", () => {
  it("matches exact terms, privately funds, delivers, settles, and withdraws", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);

    expect(await worker.submitTerms(signedTerms("BUYER", value, "buyer_submission_nonce_0001"))).toMatchObject({
      status: "WAITING_FOR_COUNTERPARTY",
    });
    expect(await worker.submitTerms(signedTerms("SELLER", value, "seller_submission_nonce_001"))).toMatchObject({
      status: "MATCH_AWAITING_BALANCE",
    });

    await claimDeposit(worker, contract, clock, "BUYER", "700", 7);
    const sellerClaim = await claimDeposit(worker, contract, clock, "SELLER", "300", 9);
    expect(sellerClaim).toMatchObject({ newlyFundedTickets: [value.ticketId] });
    expect(worker.snapshotForTesting().deals[value.ticketId]?.status).toBe("FUNDED");

    await worker.executeAction(
      signedAction("SELLER", clock, {
        type: "SUBMIT_DELIVERY",
        ticketId: value.ticketId,
        deliveryCommitment: "e".repeat(64),
      }),
    );
    await worker.executeAction(signedAction("BUYER", clock, { type: "CONFIRM_DELIVERY", ticketId: value.ticketId }));

    const settled = worker.snapshotForTesting();
    expect(settled.deals[value.ticketId]?.status).toBe("COMPLETED");
    expect(settled.accounts["buyer.testnet"]).toEqual({ availableAtomic: "200", lockedAtomic: "0" });
    expect(settled.accounts["seller.testnet"]).toEqual({ availableAtomic: "800", lockedAtomic: "0" });

    const withdrawal = await worker.executeAction(
      signedAction("BUYER", clock, {
        type: "REQUEST_WITHDRAWAL",
        recipientId: "buyer.testnet",
        amountAtomic: "50",
      }),
    );
    expect(withdrawal.withdrawalStatus).toBe("COMPLETED");
    expect(worker.snapshotForTesting().accounts["buyer.testnet"]?.availableAtomic).toBe("150");
    expect(contract.roots.length).toBeGreaterThanOrEqual(5);
  });

  it("returns NO_MATCH without revealing the counterparty terms and supports a new round", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const buyerTerms = terms(clock);
    const sellerTerms = terms(clock, { priceAtomic: "501" });
    await worker.submitTerms(signedTerms("BUYER", buyerTerms, "buyer_submission_nonce_0001"));
    const mismatch = await worker.submitTerms(signedTerms("SELLER", sellerTerms, "seller_submission_nonce_001"));
    expect(mismatch).toEqual({ status: "NO_MATCH", round: 1 });
    expect(JSON.stringify(mismatch)).not.toContain("500");
    expect(JSON.stringify(mismatch)).not.toContain("501");

    await worker.submitTerms(signedTerms("BUYER", buyerTerms, "buyer_submission_nonce_0002"));
    const matched = await worker.submitTerms(signedTerms("SELLER", buyerTerms, "seller_submission_nonce_002"));
    expect(matched.status).toBe("MATCH_AWAITING_BALANCE");
    expect(matched.round).toBe(2);
    expect(contract.roots).toHaveLength(1);
  });

  it("rejects signature nonce replay", async () => {
    const { clock, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const submission = signedTerms("BUYER", terms(clock), "buyer_submission_nonce_0001");
    await worker.submitTerms(submission);
    await expect(worker.submitTerms(submission)).rejects.toMatchObject({ code: "NONCE_REPLAY" });
  });

  it("rejects tampered actions, action nonce replay, role confusion, and non-party access", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();

    const action = signedAction("BUYER", clock, { type: "GET_BALANCE" }, "replayed_action_nonce_0001");
    await worker.executeAction(action);
    await expect(worker.executeAction(action)).rejects.toMatchObject({ code: "NONCE_REPLAY" });
    await expect(worker.executeAction({
      ...signedAction("BUYER", clock, { type: "GET_BALANCE" }),
      action: { type: "REQUEST_WITHDRAWAL", recipientId: "buyer.testnet", amountAtomic: "1" },
    })).rejects.toThrow(/Invalid action signature/);

    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    await expect(worker.executeAction(signedAction("BUYER", clock, {
      type: "SUBMIT_DELIVERY",
      ticketId: value.ticketId,
      deliveryCommitment: "e".repeat(64),
    }))).rejects.toMatchObject({ code: "SELLER_ONLY" });
    await expect(worker.executeAction(signedAction("SELLER", clock, {
      type: "CONFIRM_DELIVERY",
      ticketId: value.ticketId,
    }))).rejects.toMatchObject({ code: "BUYER_ONLY" });
    await expect(worker.executeAction(signedAction("OUTSIDER", clock, {
      type: "GET_DEAL_STATUS",
      ticketId: value.ticketId,
    }))).rejects.toMatchObject({ code: "DEAL_ACCESS_DENIED" });
  });

  it("keeps deals unfunded with insufficient balances and rejects balance overflow", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await worker.submitTerms(signedTerms("BUYER", value, "buyer_submission_nonce_0001"));
    await worker.submitTerms(signedTerms("SELLER", value, "seller_submission_nonce_001"));
    await claimDeposit(worker, contract, clock, "BUYER", "599", 7);
    await claimDeposit(worker, contract, clock, "SELLER", "200", 9);
    expect(worker.snapshotForTesting().deals[value.ticketId]?.status).toBe("MATCHED_AWAITING_BALANCE");
    await expect(worker.executeAction(signedAction("BUYER", clock, {
      type: "REQUEST_WITHDRAWAL",
      recipientId: "buyer.testnet",
      amountAtomic: "600",
    }))).rejects.toMatchObject({ code: "INSUFFICIENT_AVAILABLE_BALANCE" });

    const overflow = environment();
    const overflowWorker = overflow.createWorker();
    await overflowWorker.initialize();
    await claimDeposit(overflowWorker, overflow.contract, overflow.clock, "BUYER", ((1n << 128n) - 1n).toString(), 13);
    await expect(claimDeposit(overflowWorker, overflow.contract, overflow.clock, "BUYER", "1", 14)).rejects.toThrow(/overflow/);
    expect(overflowWorker.snapshotForTesting().accounts["buyer.testnet"]?.availableAtomic).toBe(((1n << 128n) - 1n).toString());
  });

  it("applies seller timeout and transfers seller collateral to the buyer", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    clock.value = BigInt(value.deliveryDeadlineNs) + 1n;
    await worker.executeAction(signedAction("BUYER", clock, { type: "PROCESS_TIMEOUT", ticketId: value.ticketId }));
    const state = worker.snapshotForTesting();
    expect(state.deals[value.ticketId]?.status).toBe("SELLER_TIMEOUT");
    expect(state.accounts["buyer.testnet"]).toEqual({ availableAtomic: "900", lockedAtomic: "0" });
    expect(state.accounts["seller.testnet"]).toEqual({ availableAtomic: "100", lockedAtomic: "0" });
  });

  it("auto-releases a recorded delivery after the buyer confirmation deadline", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    await worker.executeAction(
      signedAction("SELLER", clock, {
        type: "SUBMIT_DELIVERY",
        ticketId: value.ticketId,
        deliveryCommitment: "e".repeat(64),
      }),
    );
    clock.value = BigInt(value.confirmationDeadlineNs) + 1n;
    await worker.executeAction(signedAction("SELLER", clock, { type: "PROCESS_TIMEOUT", ticketId: value.ticketId }));
    const state = worker.snapshotForTesting();
    expect(state.deals[value.ticketId]?.status).toBe("AUTO_RELEASED");
    expect(state.accounts["buyer.testnet"]).toEqual({ availableAtomic: "200", lockedAtomic: "0" });
    expect(state.accounts["seller.testnet"]).toEqual({ availableAtomic: "800", lockedAtomic: "0" });
  });

  it("automatically settles due timeouts during internal maintenance", async () => {
    const { clock, contract, createWorker } = environment("BATCHED");
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    expect(contract.roots).toHaveLength(0);

    clock.value = BigInt(value.deliveryDeadlineNs) + 1n;
    const maintenance = await worker.runMaintenance();

    expect(maintenance).toEqual({ timedOutDeals: 1, anchored: true });
    expect(worker.snapshotForTesting().deals[value.ticketId]?.status).toBe("SELLER_TIMEOUT");
    expect(contract.roots).toHaveLength(1);
    expect(await worker.runMaintenance()).toEqual({ timedOutDeals: 0, anchored: false });
    expect(contract.roots).toHaveLength(1);
  });

  it("batches state roots but force-anchors before a withdrawal", async () => {
    const { clock, contract, createWorker } = environment("BATCHED");
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    await worker.executeAction(
      signedAction("SELLER", clock, {
        type: "SUBMIT_DELIVERY",
        ticketId: value.ticketId,
        deliveryCommitment: "e".repeat(64),
      }),
    );
    await worker.executeAction(signedAction("BUYER", clock, { type: "CONFIRM_DELIVERY", ticketId: value.ticketId }));
    expect(contract.roots).toHaveLength(0);

    expect(await worker.runMaintenance()).toEqual({ timedOutDeals: 0, anchored: true });
    expect(contract.roots).toHaveLength(1);
    expect(await worker.runMaintenance()).toEqual({ timedOutDeals: 0, anchored: false });
    expect(contract.roots).toHaveLength(1);

    await worker.executeAction(
      signedAction("BUYER", clock, {
        type: "REQUEST_WITHDRAWAL",
        recipientId: "buyer.testnet",
        amountAtomic: "50",
      }),
    );
    expect(contract.roots).toHaveLength(2);
    expect(contract.withdrawals.size).toBe(1);
  });

  it("requires both parties for cancellation and atomically unlocks their balances", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await matchAndFund(worker, contract, clock, value);
    const rootsBeforeCancellation = contract.roots.length;
    const first = await worker.executeAction(
      signedAction("BUYER", clock, { type: "REQUEST_CANCELLATION", ticketId: value.ticketId }),
    );
    expect(first.status).toBe("WAITING_FOR_COUNTERPARTY_CANCELLATION");
    expect(contract.roots).toHaveLength(rootsBeforeCancellation + 1);
    await worker.executeAction(
      signedAction("SELLER", clock, { type: "REQUEST_CANCELLATION", ticketId: value.ticketId }),
    );
    const state = worker.snapshotForTesting();
    expect(state.deals[value.ticketId]?.status).toBe("CANCELLED");
    expect(state.accounts["buyer.testnet"]).toEqual({ availableAtomic: "700", lockedAtomic: "0" });
    expect(state.accounts["seller.testnet"]).toEqual({ availableAtomic: "300", lockedAtomic: "0" });
    expect(contract.roots).toHaveLength(rootsBeforeCancellation + 2);
  });

  it("expires an unfunded match and never locks deposits submitted after its funding deadline", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const value = terms(clock);
    await worker.submitTerms(signedTerms("BUYER", value, "buyer_submission_nonce_0001"));
    await worker.submitTerms(signedTerms("SELLER", value, "seller_submission_nonce_001"));
    clock.value = BigInt(value.fundingDeadlineNs) + 1n;
    await claimDeposit(worker, contract, clock, "BUYER", "700", 7);
    expect(worker.snapshotForTesting().deals[value.ticketId]?.status).toBe("MATCHED_AWAITING_BALANCE");
    await worker.executeAction(signedAction("BUYER", clock, { type: "PROCESS_TIMEOUT", ticketId: value.ticketId }));
    expect(worker.snapshotForTesting().deals[value.ticketId]?.status).toBe("CANCELLED");
    expect(worker.snapshotForTesting().accounts["buyer.testnet"]).toEqual({ availableAtomic: "700", lockedAtomic: "0" });
  });

  it("rejects expired and overly long signed request lifetimes", async () => {
    const { clock, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const expired = terms(clock, { expiresAtNs: clock.value.toString() });
    await expect(
      worker.submitTerms(signedTerms("BUYER", expired, "buyer_submission_nonce_expired1")),
    ).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });

    const tooDistant = terms(clock, {
      fundingDeadlineNs: (clock.value + 30n * 60n * 60n * 1_000_000_000n).toString(),
      deliveryDeadlineNs: (clock.value + 31n * 60n * 60n * 1_000_000_000n).toString(),
      confirmationDeadlineNs: (clock.value + 32n * 60n * 60n * 1_000_000_000n).toString(),
      expiresAtNs: (clock.value + 25n * 60n * 60n * 1_000_000_000n).toString(),
    });
    await expect(
      worker.submitTerms(signedTerms("BUYER", tooDistant, "buyer_submission_nonce_distant1")),
    ).rejects.toMatchObject({ code: "EXPIRY_TOO_DISTANT" });
  });

  it("recovers a saved ledger after an anchor failure", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    contract.failNextAnchor = true;
    await expect(claimDeposit(worker, contract, clock, "BUYER", "700", 7)).rejects.toMatchObject({
      code: "LEDGER_ANCHOR_PENDING",
    });

    const restarted = createWorker();
    await restarted.initialize();
    expect(restarted.snapshotForTesting().accounts["buyer.testnet"]?.availableAtomic).toBe("700");
    expect(restarted.snapshotForTesting().lastAnchoredSequence).toBe("1");
  });

  it("rejects a snapshot rollback and an on-chain root mismatch at startup", async () => {
    const first = environment();
    const worker = first.createWorker();
    await worker.initialize();
    await claimDeposit(worker, first.contract, first.clock, "BUYER", "700", 7);
    const saved = await first.store.load();
    expect(saved).not.toBeNull();
    saved!.ledgerSequence = "0";
    saved!.lastAnchoredSequence = "0";
    saved!.lastAnchoredRoot = "";
    await first.store.save(saved!);
    await expect(first.createWorker().initialize()).rejects.toMatchObject({ code: "SNAPSHOT_ROLLBACK" });

    const second = environment();
    const secondWorker = second.createWorker();
    await secondWorker.initialize();
    await claimDeposit(secondWorker, second.contract, second.clock, "BUYER", "700", 7);
    second.contract.roots[second.contract.roots.length - 1]!.root = "f".repeat(64);
    await expect(second.createWorker().initialize()).rejects.toMatchObject({ code: "ANCHOR_MISMATCH" });
  });

  it("reconciles a failed contract withdrawal after restart", async () => {
    const { clock, contract, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    await claimDeposit(worker, contract, clock, "BUYER", "700", 7);
    contract.failNextWithdrawal = true;
    await expect(
      worker.executeAction(
        signedAction("BUYER", clock, {
          type: "REQUEST_WITHDRAWAL",
          recipientId: "buyer.testnet",
          amountAtomic: "50",
        }),
      ),
    ).rejects.toMatchObject({ code: "WITHDRAWAL_PENDING" });

    const restarted = createWorker();
    await restarted.initialize();
    const records = Object.values(restarted.snapshotForTesting().withdrawals);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("COMPLETED");
    expect(restarted.snapshotForTesting().accounts["buyer.testnet"]?.availableAtomic).toBe("650");
  });

  it("decrypts signed terms and encrypts the response to the party reply key", async () => {
    const { clock, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const signed = signedTerms("BUYER", terms(clock), "buyer_submission_nonce_0001");
    const request = encryptJsonForRecipient({
      payload: signed,
      recipientPublicKey: boxPublicKeyFromSecret(teeSecret),
      recipientKeyId: "tee-key-v1",
      context: TERMS_REQUEST_CONTEXT,
    });
    const response = await worker.handleTermsEnvelope(request);
    expect(
      decryptJsonEnvelope<Record<string, unknown>>({
        envelope: response,
        recipientSecretKey: buyerReplySecret,
        expectedKeyId: "buyer-reply-v1",
        expectedContext: WORKER_RESPONSE_CONTEXT,
      }),
    ).toMatchObject({ ok: true, status: "WAITING_FOR_COUNTERPARTY" });
  });

  it("decrypts signed actions and returns encrypted private balances", async () => {
    const { clock, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const signed = signedAction("BUYER", clock, { type: "GET_BALANCE" });
    const request = encryptJsonForRecipient({
      payload: signed,
      recipientPublicKey: boxPublicKeyFromSecret(teeSecret),
      recipientKeyId: "tee-key-v1",
      context: ACTION_REQUEST_CONTEXT,
    });
    const response = await worker.handleActionEnvelope(request);
    expect(
      decryptJsonEnvelope<Record<string, unknown>>({
        envelope: response,
        recipientSecretKey: buyerReplySecret,
        expectedKeyId: "buyer-reply-v1",
        expectedContext: WORKER_RESPONSE_CONTEXT,
      }),
    ).toMatchObject({ ok: true, balance: { availableAtomic: "0", lockedAtomic: "0" } });
  });

  it("binds API withdrawal policy accounting to the encrypted signed amount", async () => {
    const { clock, createWorker } = environment();
    const worker = createWorker();
    await worker.initialize();
    const signed = signedAction("BUYER", clock, { type: "REQUEST_WITHDRAWAL", recipientId: "buyer.testnet", amountAtomic: "500" });
    const request = encryptJsonForRecipient({ payload: signed, recipientPublicKey: boxPublicKeyFromSecret(teeSecret), recipientKeyId: "tee-key-v1", context: ACTION_REQUEST_CONTEXT });
    const wrong = await worker.handleActionEnvelope(request, domainSeparatedHash(WITHDRAWAL_POLICY_DOMAIN, utf8("1")));
    expect(decryptJsonEnvelope<Record<string, unknown>>({ envelope: wrong, recipientSecretKey: buyerReplySecret, expectedKeyId: "buyer-reply-v1", expectedContext: WORKER_RESPONSE_CONTEXT })).toMatchObject({ ok: false, error: { code: "WITHDRAWAL_POLICY_MISMATCH" } });
  });
});

