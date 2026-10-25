import anyTest from "ava";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import bs58 from "bs58";
import {
  DEFAULT_PRIVATE_KEY,
  DEFAULT_PUBLIC_KEY,
  Sandbox,
} from "near-sandbox";
import {
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  createDepositCommitment,
  publicKeyFromSeed,
  signTerms,
  signWorkerAction,
} from "../../shared-types/dist/index.js";
import { NearContractGateway } from "../../tee-worker/dist/contract-gateway.js";
import { StaticIdentityVerifier } from "../../tee-worker/dist/identity.js";
import { MemoryStateStore } from "../../tee-worker/dist/snapshot-store.js";
import { ConfidentialWorker } from "../../tee-worker/dist/worker.js";

setDefaultResultOrder("ipv4first");

const test = anyTest;
const yocto = (near) => BigInt(near) * 10n ** 24n;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function account(accountId, provider) {
  return new Account(accountId, provider, DEFAULT_PRIVATE_KEY);
}

async function call(signer, contractId, methodName, args, deposit = 0n) {
  return signer.callFunctionRaw({
    contractId,
    methodName,
    args,
    gas: "30000000000000",
    deposit: deposit.toString(),
    waitUntil: "FINAL",
  });
}

test.beforeEach(async (t) => {
  const sandbox = await Sandbox.start({ version: "2.13.4" });
  t.context = { sandbox };

  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = account("sandbox", provider);
  const accounts = [
    ["depositor.sandbox", 50n],
    ["recipient.sandbox", 10n],
    ["tee.sandbox", 20n],
    ["outsider.sandbox", 20n],
    ["pool.sandbox", 30n],
  ];
  for (const [accountId, balance] of accounts) {
    await root.createSubAccount({
      accountOrPrefix: accountId,
      publicKey: DEFAULT_PUBLIC_KEY,
      nearToTransfer: yocto(balance),
    });
  }

  const depositor = account("depositor.sandbox", provider);
  const recipient = account("recipient.sandbox", provider);
  const tee = account("tee.sandbox", provider);
  const outsider = account("outsider.sandbox", provider);
  const contract = account("pool.sandbox", provider);
  await contract.deployContract(await readFile(process.argv[2]));
  await call(root, contract.accountId, "new", {
    config: {
      owner_id: root.accountId,
      tee_worker_id: tee.accountId,
      tee_measurement_hash: hash("attested-near-confidential-vm-image"),
      tee_encryption_key_hash: hash("attested-worker-encryption-key"),
      min_deposit: "1",
      max_withdrawal: yocto(100).toString(),
      max_withdrawal_per_window: yocto(500).toString(),
      withdrawal_window_ns: "60000000000",
      rotation_delay_ns: "1000000000",
    },
  });

  t.context = { sandbox, provider, root, depositor, recipient, tee, outsider, contract };
});

test.afterEach.always(async (t) => {
  await t.context.sandbox?.tearDown().catch(() => undefined);
});

test("pooled deposits, TEE-only roots, and replay-safe withdrawals work end to end", async (t) => {
  const { provider, depositor, recipient, tee, outsider, contract } = t.context;
  const commitment = hash("private-deposit-secret");
  const root = hash("private-ledger-state-1");
  const withdrawalId = hash("private-withdrawal-1");

  await call(depositor, contract.accountId, "deposit", { commitment }, yocto(5));
  const deposit = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_deposit",
    args: { depositor_id: depositor.accountId, commitment },
  });
  t.is(deposit.depositor_id, depositor.accountId);
  t.true(BigInt(deposit.amount) > 0n);
  t.true(BigInt(deposit.amount) < yocto(5));

  const unauthorized = await t.throwsAsync(
    call(outsider, contract.accountId, "anchor_ledger_root", { root, sequence: "1" }),
  );
  t.regex(String(unauthorized), /TEE worker only/);
  await call(tee, contract.accountId, "anchor_ledger_root", { root, sequence: "1" });
  await call(tee, contract.accountId, "anchor_ledger_root", { root, sequence: "1" });

  const amount = (BigInt(deposit.amount) / 2n).toString();
  const expiry = (BigInt(Date.now()) * 1_000_000n + 3_600_000_000_000n).toString();
  const unauthorizedWithdrawal = await t.throwsAsync(
    call(outsider, contract.accountId, "withdraw", {
      withdrawal_id: hash("unauthorized-private-withdrawal"),
      recipient_id: recipient.accountId,
      amount: "1",
      expiry_ns: expiry,
      ledger_root: root,
    }),
  );
  t.regex(String(unauthorizedWithdrawal), /TEE worker only/);

  await call(tee, contract.accountId, "withdraw", {
    withdrawal_id: withdrawalId,
    recipient_id: recipient.accountId,
    amount,
    expiry_ns: expiry,
    ledger_root: root,
  });

  const withdrawal = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_withdrawal",
    args: { withdrawal_id: withdrawalId },
  });
  t.is(withdrawal.status, "COMPLETED");
  t.is(withdrawal.amount, amount);
  const replay = await t.throwsAsync(
    call(tee, contract.accountId, "withdraw", {
      withdrawal_id: withdrawalId,
      recipient_id: recipient.accountId,
      amount,
      expiry_ns: expiry,
      ledger_root: root,
    }),
  );
  t.regex(String(replay), /withdrawal already used/);

  const config = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_config",
    args: {},
  });
  t.is(config.latest_ledger_sequence, "1");
  t.is(config.latest_ledger_root, root);
  t.false("deals" in config);
  for (const privateField of ["ticket_id", "price_atomic", "buyer_collateral_atomic", "seller_collateral_atomic", "delivery_commitment"]) {
    t.false(privateField in config);
  }
});

test("the confidential worker completes a private deal against the deployed contract", async (t) => {
  const { sandbox, provider, depositor, recipient, tee, outsider, contract } = t.context;
  const rawSecretKey = bs58.decode(DEFAULT_PRIVATE_KEY.slice("ed25519:".length));
  const signingSeed = rawSecretKey.slice(0, 32);
  t.is(publicKeyFromSeed(signingSeed), DEFAULT_PUBLIC_KEY);
  const replySecret = new Uint8Array(32).fill(41);
  const replyPublicKey = bytesToBase64Url(boxPublicKeyFromSecret(replySecret));
  const teeBoxSecret = new Uint8Array(32).fill(73);
  const clock = { value: BigInt(Date.now()) * 1_000_000n, nowNs() { return this.value; } };
  const workerKey = KeyPair.fromRandom("ed25519");
  await tee.addFunctionCallAccessKey({
    publicKey: workerKey.getPublicKey(),
    contractId: contract.accountId,
    methodNames: ["anchor_ledger_root", "withdraw"],
  });
  await tee.deleteKey(DEFAULT_PUBLIC_KEY);
  const gateway = await NearContractGateway.connect({
    networkId: "sandbox",
    rpcUrl: sandbox.rpcUrl,
    accountId: tee.accountId,
    privateKey: workerKey.toString(),
    contractId: contract.accountId,
  });
  const worker = new ConfidentialWorker({
    workerId: tee.accountId,
    encryptionKeyId: "sandbox-tee-key-v1",
    encryptionSecretKey: teeBoxSecret,
    stateStore: new MemoryStateStore(),
    contract: gateway,
    identityVerifier: new StaticIdentityVerifier(
      new Map([
        [depositor.accountId, new Set([DEFAULT_PUBLIC_KEY])],
        [outsider.accountId, new Set([DEFAULT_PUBLIC_KEY])],
      ]),
    ),
    clock,
  });
  await worker.initialize();

  const buyerSecret = bytesToBase64Url(new Uint8Array(32).fill(11));
  const sellerSecret = bytesToBase64Url(new Uint8Array(32).fill(19));
  await call(
    depositor,
    contract.accountId,
    "deposit",
    { commitment: createDepositCommitment(buyerSecret) },
    yocto(5),
  );
  await call(
    outsider,
    contract.accountId,
    "deposit",
    { commitment: createDepositCommitment(sellerSecret) },
    yocto(2),
  );

  let actionNonce = 0;
  const action = (actorId, value) => {
    actionNonce += 1;
    return signWorkerAction({
      actorId,
      publicKey: DEFAULT_PUBLIC_KEY,
      replyKeyId: "sandbox-reply-key-v1",
      replyPublicKey,
      nonce: `sandbox_action_nonce_${actionNonce.toString().padStart(8, "0")}`,
      expiresAtNs: (clock.value + 3_600_000_000_000n).toString(),
      action: value,
      signingSeed,
    });
  };
  await worker.executeAction(action(depositor.accountId, { type: "CLAIM_DEPOSIT", depositSecret: buyerSecret }));
  await worker.executeAction(action(outsider.accountId, { type: "CLAIM_DEPOSIT", depositSecret: sellerSecret }));

  const terms = {
    version: 1,
    ticketId: "ticket_01JSANDBOXWORKER001",
    buyerId: depositor.accountId,
    sellerId: outsider.accountId,
    assetDescriptionHash: hash("sandbox-encrypted-delivery"),
    currency: "NEAR_TESTNET",
    priceAtomic: yocto(1).toString(),
    buyerCollateralAtomic: (yocto(1) / 2n).toString(),
    sellerCollateralAtomic: (yocto(1) / 2n).toString(),
    fundingDeadlineNs: (clock.value + 7_200_000_000_000n).toString(),
    deliveryDeadlineNs: (clock.value + 10_800_000_000_000n).toString(),
    confirmationDeadlineNs: (clock.value + 14_400_000_000_000n).toString(),
    sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
    buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
    nonce: "sandbox_agreement_nonce_000001",
    expiresAtNs: (clock.value + 3_600_000_000_000n).toString(),
  };
  const signedTerms = (role, signerId, submissionNonce) =>
    signTerms({
      terms,
      role,
      signerId,
      replyKeyId: "sandbox-reply-key-v1",
      replyPublicKey,
      submissionNonce,
      signingSeed,
    });
  await worker.submitTerms(signedTerms("BUYER", depositor.accountId, "sandbox_buyer_submission_0001"));
  const match = await worker.submitTerms(
    signedTerms("SELLER", outsider.accountId, "sandbox_seller_submission_001"),
  );
  t.is(match.status, "MATCH");

  await worker.executeAction(
    action(outsider.accountId, {
      type: "SUBMIT_DELIVERY",
      ticketId: terms.ticketId,
      deliveryCommitment: hash("sandbox-delivery-ciphertext"),
    }),
  );
  await worker.executeAction(
    action(depositor.accountId, { type: "CONFIRM_DELIVERY", ticketId: terms.ticketId }),
  );
  const privateState = worker.snapshotForTesting();
  t.is(privateState.deals[terms.ticketId].status, "COMPLETED");
  t.is(privateState.accounts[depositor.accountId].lockedAtomic, "0");
  t.is(privateState.accounts[outsider.accountId].lockedAtomic, "0");

  const withdrawal = await worker.executeAction(
    action(depositor.accountId, {
      type: "REQUEST_WITHDRAWAL",
      recipientId: recipient.accountId,
      amountAtomic: (yocto(1) / 10n).toString(),
    }),
  );
  t.is(withdrawal.withdrawalStatus, "COMPLETED");
  const publicWithdrawal = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_withdrawal",
    args: { withdrawal_id: withdrawal.withdrawalId },
  });
  t.is(publicWithdrawal.status, "COMPLETED");
  const config = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_config",
    args: {},
  });
  const finalPrivateState = worker.snapshotForTesting();
  t.is(config.latest_ledger_sequence, finalPrivateState.lastAnchoredSequence);
  t.true(BigInt(config.latest_ledger_sequence) >= 6n);
  t.false("deals" in config);
  const buyerDeposit = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_deposit",
    args: { depositor_id: depositor.accountId, commitment: createDepositCommitment(buyerSecret) },
  });
  const publicChainViews = JSON.stringify({ config, publicWithdrawal, buyerDeposit });
  for (const privateValue of [
    terms.ticketId,
    terms.nonce,
    terms.assetDescriptionHash,
    terms.fundingDeadlineNs,
    hash("sandbox-delivery-ciphertext"),
  ]) {
    t.false(publicChainViews.includes(privateValue));
  }
});
