import {
  assertTestnetChain,
  requireAccount,
  required,
  requireTestnetRpc,
  rpc,
  writeEvidence,
} from "./phase9-lib.mjs";

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const ownerId = requireAccount(required("NEAR_OWNER_ACCOUNT_ID"), "NEAR_OWNER_ACCOUNT_ID");
const inputs = [
  ["deploy", required("NEAR_DEPLOY_TRANSACTION_HASH"), contractId],
  ["initialize", required("NEAR_INITIALIZE_TRANSACTION_HASH"), contractId],
  ["pause", required("NEAR_PAUSE_TRANSACTION_HASH"), ownerId],
];
const transactions = [];
for (const [label, hash, signerId] of inputs) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(hash)) throw new Error(`${label} transaction hash is invalid`);
  const outcome = await rpc(rpcUrl, "tx", [hash, signerId]);
  if (!isSuccess(outcome.status)) throw new Error(`${label} transaction did not succeed`);
  if (outcome.transaction?.receiver_id !== contractId) throw new Error(`${label} transaction receiver does not match the pool contract`);
  transactions.push({
    label,
    hash,
    signerId: outcome.transaction.signer_id,
    receiverId: outcome.transaction.receiver_id,
    blockHash: outcome.transaction_outcome?.block_hash,
    status: "SUCCESS",
  });
}

const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  contractId,
  transactions,
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function isSuccess(status) {
  return typeof status === "object" && status !== null
    && (Object.hasOwn(status, "SuccessValue") || Object.hasOwn(status, "SuccessReceiptId"));
}
