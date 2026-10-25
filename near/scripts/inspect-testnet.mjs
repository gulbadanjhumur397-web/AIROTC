import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HASH_PATTERN,
  assertTestnetChain,
  requireAccount,
  required,
  requireTestnetRpc,
  rpc,
  sha256,
  viewFunction,
  viewRequest,
  writeEvidence,
} from "./phase9-lib.mjs";

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const expectedWorkerId = requireAccount(required("TEE_NEAR_ACCOUNT_ID"), "TEE_NEAR_ACCOUNT_ID");
const provisionalIdentity = process.env.TEE_IDENTITY_PROVISIONAL === "true";
const providerStatus = await assertTestnetChain(rpcUrl);
const [account, code, config, keyList] = await Promise.all([
  rpc(rpcUrl, "query", viewRequest(contractId, "view_account")),
  rpc(rpcUrl, "query", viewRequest(contractId, "view_code")),
  viewFunction(rpcUrl, contractId, "get_config"),
  rpc(rpcUrl, "query", viewRequest(expectedWorkerId, "view_access_key_list")),
]);
if (config.tee_worker_id !== expectedWorkerId) throw new Error("Contract worker account does not match TEE_NEAR_ACCOUNT_ID");
if (!HASH_PATTERN.test(config.tee_measurement_hash) || !HASH_PATTERN.test(config.tee_encryption_key_hash)) {
  throw new Error("Contract contains invalid TEE identity hashes");
}
if (keyList.keys.length !== 1) throw new Error("TEE worker account must have exactly one access key");
const key = keyList.keys[0];
const permission = key.access_key?.permission?.FunctionCall;
if (provisionalIdentity) {
  if (config.paused !== true) throw new Error("A provisional TEE identity requires the pool contract to be paused");
  if (key.access_key?.permission !== "FullAccess") throw new Error("Provisional worker account must retain exactly its bootstrap FullAccess key");
} else {
  if (!permission || permission.receiver_id !== contractId) throw new Error("TEE worker key is not restricted to the pool contract");
  if ([...permission.method_names].sort().join(",") !== "anchor_ledger_root,withdraw") {
    throw new Error("TEE worker key has an invalid method scope");
  }
}

const wasmPath = resolve(process.env.NEAR_POOL_WASM_PATH ?? new URL("../escrow-contract/build/air-otc-pool.wasm", import.meta.url).pathname);
const wasm = await readFile(wasmPath);
const serviceEvidence = {};
if (process.env.PRIVACY_API_URL) {
  const base = new URL(process.env.PRIVACY_API_URL);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("Hosted PRIVACY_API_URL must use HTTPS");
  }
  serviceEvidence.apiHealth = await getJson(new URL("/health", base));
  serviceEvidence.workerIdentity = await getJson(new URL("/v1/worker/identity", base));
  const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  serviceEvidence.attestation = await getJson(new URL(`/v1/worker/attestation?nonce=${nonce.slice(0, 64)}`, base));
}

const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  chainId: providerStatus.chain_id,
  latestBlockHeight: providerStatus.sync_info?.latest_block_height,
  contract: {
    accountId: contractId,
    balanceAtomic: account.amount,
    chainCodeHash: code.code_hash,
    localWasmSha256: sha256(wasm),
    localWasmBytes: wasm.length,
    config,
  },
  workerAccessKey: {
    accountId: expectedWorkerId,
    publicKey: key.public_key,
    receiverId: permission?.receiver_id ?? null,
    methodNames: permission?.method_names ?? [],
    allowance: permission?.allowance ?? null,
    onlyKey: true,
    status: provisionalIdentity ? "BOOTSTRAP_FULL_ACCESS_PENDING_CVM_PROVISIONING" : "RESTRICTED_OPERATIONAL_KEY",
  },
  services: serviceEvidence,
  privateFieldInspection: inspectPrivateFields(config),
  identityStatus: provisionalIdentity ? "PROVISIONAL_PENDING_HOSTED_ATTESTATION" : "VERIFIED",
  note: "Platform attestation signature and event-log verification must also be saved from the NEAR Confidential Compute verifier.",
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Hosted service ${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

function inspectPrivateFields(value) {
  const serialized = JSON.stringify(value).toLowerCase();
  const forbidden = ["ticket_id", "price_atomic", "buyer_collateral", "seller_collateral", "delivery_commitment", "product", "private_balance"];
  const found = forbidden.filter((field) => serialized.includes(field));
  if (found.length > 0) throw new Error(`Public contract state exposed private fields: ${found.join(", ")}`);
  return { passed: true, forbiddenFieldsFound: [] };
}
