import { Account, JsonRpcProvider, KeyPair, PublicKey } from "near-api-js";
import { assertTestnetChain, requireAccount, required, requireTestnetRpc, rpc, viewRequest, writeEvidence } from "./phase9-lib.mjs";

if (process.env.CONFIRM_WORKER_KEY_LOCKDOWN !== "LOCK_AIROTC_WORKER_KEY") {
  throw new Error("Set CONFIRM_WORKER_KEY_LOCKDOWN=LOCK_AIROTC_WORKER_KEY to add the restricted key and remove the bootstrap FullAccess key");
}
if (process.env.TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM !== "true") {
  throw new Error("TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM=true is required before removing the bootstrap key");
}

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const workerId = requireAccount(required("TEE_NEAR_ACCOUNT_ID"), "TEE_NEAR_ACCOUNT_ID");
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const bootstrapPrivateKey = required("WORKER_BOOTSTRAP_PRIVATE_KEY");
const operationalPublicKeyText = required("TEE_WORKER_PUBLIC_KEY");
if (!operationalPublicKeyText.startsWith("ed25519:")) throw new Error("TEE_WORKER_PUBLIC_KEY must be ed25519");

const bootstrap = KeyPair.fromString(bootstrapPrivateKey);
const bootstrapPublicKey = bootstrap.getPublicKey().toString();
if (bootstrapPublicKey === operationalPublicKeyText) throw new Error("Bootstrap and operational keys must be different");
const initial = await rpc(rpcUrl, "query", viewRequest(workerId, "view_access_key_list"));
const initialKeys = initial.keys.map((entry) => entry.public_key);
if (!initialKeys.includes(bootstrapPublicKey)) throw new Error("Bootstrap FullAccess key is not present on the worker account");
if (initialKeys.some((key) => key !== bootstrapPublicKey && key !== operationalPublicKeyText)) {
  throw new Error("Worker account contains an unexpected access key; refusing automatic lockdown");
}
const bootstrapView = await rpc(rpcUrl, "query", viewRequest(workerId, "view_access_key", { public_key: bootstrapPublicKey }));
if (bootstrapView.permission !== "FullAccess") throw new Error("Bootstrap key is not FullAccess");

const provider = new JsonRpcProvider({ url: rpcUrl });
const account = new Account(workerId, provider, bootstrapPrivateKey);
if (!initialKeys.includes(operationalPublicKeyText)) {
  await account.addFunctionCallAccessKey({
    publicKey: PublicKey.fromString(operationalPublicKeyText),
    contractId,
    methodNames: ["anchor_ledger_root", "withdraw"],
  });
}
const restricted = await rpc(rpcUrl, "query", viewRequest(workerId, "view_access_key", { public_key: operationalPublicKeyText }));
const permission = restricted.permission?.FunctionCall;
if (!permission || permission.receiver_id !== contractId) throw new Error("Operational key receiver verification failed");
if ([...permission.method_names].sort().join(",") !== "anchor_ledger_root,withdraw") {
  throw new Error("Operational key method restriction verification failed");
}

await account.deleteKey(bootstrap.getPublicKey());
const final = await rpc(rpcUrl, "query", viewRequest(workerId, "view_access_key_list"));
if (final.keys.length !== 1 || final.keys[0].public_key !== operationalPublicKeyText) {
  throw new Error("Worker account lockdown did not produce exactly one operational key");
}
const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  workerId,
  contractId,
  operationalPublicKey: operationalPublicKeyText,
  permission,
  bootstrapKeyRemoved: true,
  finalKeyCount: final.keys.length,
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
