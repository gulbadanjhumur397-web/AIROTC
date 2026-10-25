import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import {
  assertTestnetChain,
  requireAccount,
  requireHash,
  required,
  requireTestnetRpc,
  rpc,
  viewFunction,
  viewRequest,
  writeEvidence,
} from "./phase9-lib.mjs";

const action = process.argv[2];
if (action !== "propose" && action !== "activate") {
  throw new Error("Usage: node scripts/register-hosted-tee.mjs <propose|activate>");
}
if (process.env.CONFIRM_HOSTED_TEE_REGISTRATION !== "REGISTER_VERIFIED_HOSTED_TEE") {
  throw new Error("Set CONFIRM_HOSTED_TEE_REGISTRATION=REGISTER_VERIFIED_HOSTED_TEE to authorize hosted TEE registration");
}
if (process.env.TEE_ATTESTATION_VERIFIED !== "true") {
  throw new Error("TEE_ATTESTATION_VERIFIED=true is required after independent quote and event-log verification");
}
if (process.env.TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM !== "true") {
  throw new Error("TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM=true is required before hosted TEE registration");
}
if (process.env.TEE_IDENTITY_PROVISIONAL === "true") {
  throw new Error("Replace the provisional TEE identity values before hosted registration");
}
const image = required("TEE_WORKER_IMAGE");
if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("TEE_WORKER_IMAGE must be pinned to an immutable SHA-256 digest");

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const ownerId = requireAccount(required("NEAR_OWNER_ACCOUNT_ID"), "NEAR_OWNER_ACCOUNT_ID");
const workerId = requireAccount(required("TEE_NEAR_ACCOUNT_ID"), "TEE_NEAR_ACCOUNT_ID");
const measurementHash = requireHash(required("TEE_MEASUREMENT_HASH"), "TEE_MEASUREMENT_HASH");
const encryptionKeyHash = requireHash(required("TEE_ENCRYPTION_KEY_HASH"), "TEE_ENCRYPTION_KEY_HASH");
const operationalPublicKey = required("TEE_WORKER_PUBLIC_KEY");
const ownerPrivateKey = required("NEAR_OWNER_PRIVATE_KEY");

const ownerPair = KeyPair.fromString(ownerPrivateKey);
const ownerAccessKey = await rpc(rpcUrl, "query", viewRequest(ownerId, "view_access_key", {
  public_key: ownerPair.getPublicKey().toString(),
}));
if (ownerAccessKey.permission !== "FullAccess") throw new Error("Owner key must have FullAccess");
await verifyWorkerKey();

const provider = new JsonRpcProvider({ url: rpcUrl });
const owner = new Account(ownerId, provider, ownerPrivateKey);
let config = await viewFunction(rpcUrl, contractId, "get_config");
if (config.paused !== true) throw new Error("Pool must remain paused during hosted TEE registration");
let transactionHash;
let unpauseTransactionHash = null;

if (action === "propose") {
  if (config.pending_worker !== null) throw new Error("A TEE worker proposal is already pending");
  const outcome = await owner.callFunctionRaw({
    contractId,
    methodName: "propose_tee_worker",
    args: {
      account_id: workerId,
      measurement_hash: measurementHash,
      encryption_key_hash: encryptionKeyHash,
    },
    gas: "30000000000000",
    deposit: "0",
    waitUntil: "FINAL",
  });
  transactionHash = outcome.transaction.hash;
  config = await viewFunction(rpcUrl, contractId, "get_config");
  requirePendingMatch(config.pending_worker);
} else {
  requirePendingMatch(config.pending_worker);
  const outcome = await owner.callFunctionRaw({
    contractId,
    methodName: "activate_tee_worker",
    args: {},
    gas: "30000000000000",
    deposit: "0",
    waitUntil: "FINAL",
  });
  transactionHash = outcome.transaction.hash;
  config = await viewFunction(rpcUrl, contractId, "get_config");
  if (config.pending_worker !== null) throw new Error("TEE proposal remained pending after activation");
  if (config.tee_worker_id !== workerId || config.tee_measurement_hash !== measurementHash || config.tee_encryption_key_hash !== encryptionKeyHash) {
    throw new Error("Activated TEE identity does not match the verified hosted identity");
  }
  if (config.paused !== true) throw new Error("Pool unexpectedly unpaused during activation");
  const unpause = await owner.callFunctionRaw({
    contractId,
    methodName: "set_paused",
    args: { paused: false },
    gas: "30000000000000",
    deposit: "0",
    waitUntil: "FINAL",
  });
  unpauseTransactionHash = unpause.transaction.hash;
  config = await viewFunction(rpcUrl, contractId, "get_config");
  if (config.paused !== false) throw new Error("Pool did not unpause after verified hosted TEE activation");
}

const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  action,
  contractId,
  workerId,
  workerPublicKey: operationalPublicKey,
  measurementHash,
  encryptionKeyHash,
  image,
  transactionHash,
  unpauseTransactionHash,
  config,
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function verifyWorkerKey() {
  const keyList = await rpc(rpcUrl, "query", viewRequest(workerId, "view_access_key_list"));
  if (keyList.keys.length !== 1 || keyList.keys[0].public_key !== operationalPublicKey) {
    throw new Error("Worker account must contain only the expected operational key");
  }
  const permission = keyList.keys[0].access_key?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== contractId) throw new Error("Worker key is not restricted to the pool contract");
  if ([...permission.method_names].sort().join(",") !== "anchor_ledger_root,withdraw") {
    throw new Error("Worker key must be restricted to anchor_ledger_root and withdraw");
  }
}

function requirePendingMatch(pending) {
  if (!pending) throw new Error("No TEE worker proposal is pending");
  if (pending.account_id !== workerId || pending.measurement_hash !== measurementHash || pending.encryption_key_hash !== encryptionKeyHash) {
    throw new Error("Pending TEE worker proposal does not match the verified hosted identity");
  }
}
