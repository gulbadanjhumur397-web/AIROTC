import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  requireAccount,
  assertTestnetChain,
  requireAtomic,
  required,
  requireHash,
  requireTestnetRpc,
  rpc,
  sha256,
  viewFunction,
  viewRequest,
  writeEvidence,
} from "./phase9-lib.mjs";

if (process.env.CONFIRM_TESTNET_DEPLOY !== "DEPLOY_AIROTC_TESTNET") {
  throw new Error("Set CONFIRM_TESTNET_DEPLOY=DEPLOY_AIROTC_TESTNET to authorize the testnet transaction");
}

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const ownerId = requireAccount(required("NEAR_OWNER_ACCOUNT_ID"), "NEAR_OWNER_ACCOUNT_ID");
const workerId = requireAccount(required("TEE_NEAR_ACCOUNT_ID"), "TEE_NEAR_ACCOUNT_ID");
const measurementHash = requireHash(required("TEE_MEASUREMENT_HASH"), "TEE_MEASUREMENT_HASH");
const encryptionKeyHash = requireHash(required("TEE_ENCRYPTION_KEY_HASH"), "TEE_ENCRYPTION_KEY_HASH");
const provisionalIdentity = process.env.TEE_IDENTITY_PROVISIONAL === "true";
if (provisionalIdentity && process.env.CONFIRM_PROVISIONAL_PAUSED_BOOTSTRAP !== "DEPLOY_PAUSED_PENDING_TEE") {
  throw new Error("A provisional identity requires CONFIRM_PROVISIONAL_PAUSED_BOOTSTRAP=DEPLOY_PAUSED_PENDING_TEE");
}
const privateKey = required("NEAR_POOL_PRIVATE_KEY");
if (!privateKey.startsWith("ed25519:")) throw new Error("NEAR_POOL_PRIVATE_KEY must be an ed25519 key");

const config = {
  owner_id: ownerId,
  tee_worker_id: workerId,
  tee_measurement_hash: measurementHash,
  tee_encryption_key_hash: encryptionKeyHash,
  min_deposit: requireAtomic(process.env.POOL_MIN_DEPOSIT_ATOMIC ?? "1000000000000000000000", "POOL_MIN_DEPOSIT_ATOMIC", false),
  max_withdrawal: requireAtomic(process.env.POOL_MAX_WITHDRAWAL_ATOMIC ?? "10000000000000000000000000", "POOL_MAX_WITHDRAWAL_ATOMIC", false),
  max_withdrawal_per_window: requireAtomic(process.env.POOL_WINDOW_LIMIT_ATOMIC ?? "50000000000000000000000000", "POOL_WINDOW_LIMIT_ATOMIC", false),
  withdrawal_window_ns: requireAtomic(process.env.POOL_WINDOW_NS ?? "3600000000000", "POOL_WINDOW_NS", false),
  rotation_delay_ns: requireAtomic(process.env.POOL_ROTATION_DELAY_NS ?? "60000000000", "POOL_ROTATION_DELAY_NS", false),
};
if (BigInt(config.max_withdrawal_per_window) < BigInt(config.max_withdrawal)) {
  throw new Error("POOL_WINDOW_LIMIT_ATOMIC must be at least POOL_MAX_WITHDRAWAL_ATOMIC");
}

const wasmPath = resolve(process.env.NEAR_POOL_WASM_PATH ?? new URL("../escrow-contract/build/air-otc-pool.wasm", import.meta.url).pathname);
const wasm = await readFile(wasmPath);
const wasmSha256 = sha256(wasm);
const provider = new JsonRpcProvider({ url: rpcUrl });
const accountView = await rpc(rpcUrl, "query", viewRequest(contractId, "view_account"));
const minimumBalance = BigInt(process.env.MIN_CONTRACT_ACCOUNT_BALANCE_ATOMIC ?? "3000000000000000000000000");
if (BigInt(accountView.amount) < minimumBalance) {
  throw new Error(`Contract account has too little testnet NEAR; require at least ${minimumBalance} yoctoNEAR before deployment`);
}
const keyPair = KeyPair.fromString(privateKey);
const publicKey = keyPair.getPublicKey().toString();
const accessKey = await rpc(rpcUrl, "query", viewRequest(contractId, "view_access_key", { public_key: publicKey }));
if (accessKey.permission !== "FullAccess") throw new Error("Contract deployment key must have FullAccess on the contract account");

let existingCode = null;
try { existingCode = await rpc(rpcUrl, "query", viewRequest(contractId, "view_code")); } catch { /* empty account */ }
if (existingCode?.code_hash && existingCode.code_hash !== "11111111111111111111111111111111") {
  throw new Error("Contract account already contains code; refusing to overwrite it");
}

const account = new Account(contractId, provider, privateKey);
const deployOutcome = await account.deployContract(wasm);
const initOutcome = await account.callFunctionRaw({
  contractId,
  methodName: "new",
  args: { config },
  gas: "100000000000000",
  deposit: "0",
  waitUntil: "FINAL",
});
let pauseOutcome = null;
if (provisionalIdentity) {
  const ownerPrivateKey = required("NEAR_OWNER_PRIVATE_KEY");
  const ownerKeyPair = KeyPair.fromString(ownerPrivateKey);
  const ownerPublicKey = ownerKeyPair.getPublicKey().toString();
  const ownerAccessKey = await rpc(rpcUrl, "query", viewRequest(ownerId, "view_access_key", { public_key: ownerPublicKey }));
  if (ownerAccessKey.permission !== "FullAccess") throw new Error("Owner bootstrap key must have FullAccess");
  const owner = new Account(ownerId, provider, ownerPrivateKey);
  pauseOutcome = await owner.callFunctionRaw({
    contractId,
    methodName: "set_paused",
    args: { paused: true },
    gas: "30000000000000",
    deposit: "0",
    waitUntil: "FINAL",
  });
}
const deployedConfig = await viewFunction(rpcUrl, contractId, "get_config");
if (provisionalIdentity && deployedConfig.paused !== true) {
  throw new Error("Provisional deployment did not finish in the required paused state");
}
const code = await rpc(rpcUrl, "query", viewRequest(contractId, "view_code"));
const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  contractId,
  wasmBytes: wasm.length,
  wasmSha256,
  chainCodeHash: code.code_hash,
  deployTransactionHash: deployOutcome.transaction.hash,
  initializeTransactionHash: initOutcome.transaction.hash,
  pauseTransactionHash: pauseOutcome?.transaction.hash ?? null,
  identityStatus: provisionalIdentity ? "PROVISIONAL_PENDING_HOSTED_ATTESTATION" : "VERIFIED",
  config: deployedConfig,
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
