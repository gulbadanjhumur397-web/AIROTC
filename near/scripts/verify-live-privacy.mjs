import {
  assertTestnetChain,
  requireAccount,
  required,
  requireTestnetRpc,
  rpc,
  viewFunction,
  writeEvidence,
} from "./phase9-lib.mjs";

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const workerId = requireAccount(required("TEE_NEAR_ACCOUNT_ID"), "TEE_NEAR_ACCOUNT_ID");
const nearBlocksBase = new URL(process.env.NEARBLOCKS_API_URL ?? "https://api-testnet.nearblocks.io/");
const output = process.env.PHASE9_EVIDENCE_FILE ?? "evidence/live-explorer-privacy.json";

const expected = [
  publicInput("buyer-deposit", "LIVE_BUYER_DEPOSIT_TX_HASH", "DEMO_BUYER_ACCOUNT_ID", "deposit"),
  publicInput("seller-deposit", "LIVE_SELLER_DEPOSIT_TX_HASH", "DEMO_SELLER_ACCOUNT_ID", "deposit"),
  publicInput("buyer-withdrawal", "LIVE_BUYER_WITHDRAWAL_TX_HASH", "TEE_NEAR_ACCOUNT_ID", "withdraw"),
  publicInput("seller-withdrawal", "LIVE_SELLER_WITHDRAWAL_TX_HASH", "TEE_NEAR_ACCOUNT_ID", "withdraw"),
];

const historyUrl = new URL(`v3/accounts/${encodeURIComponent(workerId)}/txns`, nearBlocksBase);
historyUrl.searchParams.set("per_page", "100");
historyUrl.searchParams.set("order", "desc");
const historyResponse = await fetch(historyUrl, { signal: AbortSignal.timeout(20_000) });
if (!historyResponse.ok) throw new Error(`NearBlocks worker history returned HTTP ${historyResponse.status}`);
const history = await historyResponse.json();
if (!Array.isArray(history?.data)) throw new Error("NearBlocks worker history is invalid");

const workerTransactions = history.data
  .filter((item) => item?.signer_account_id === workerId && item?.receiver_account_id === contractId)
  .filter((item) => Array.isArray(item.actions) && item.actions.some((action) => action?.method === "anchor_ledger_root" || action?.method === "withdraw"))
  .map((item) => ({
    label: item.actions.some((action) => action?.method === "withdraw") ? "worker-withdrawal" : "worker-root-anchor",
    hash: requireTransactionHash(item.transaction_hash, "NearBlocks transaction hash"),
    signerId: workerId,
  }));
if (workerTransactions.length < 4) throw new Error("NearBlocks did not return the expected worker activity");

const inputs = uniqueByHash([...expected, ...workerTransactions]);
const transactions = await Promise.all(inputs.map(inspectTransaction));

async function inspectTransaction(input) {
  const outcome = await rpc(rpcUrl, "tx", [input.hash, input.signerId]);
  if (!isSuccess(outcome.status)) throw new Error(`${input.label} did not succeed`);
  if (outcome.transaction?.receiver_id !== contractId) throw new Error(`${input.label} receiver mismatch`);
  const calls = outcome.transaction.actions
    .map((action) => action?.FunctionCall)
    .filter(Boolean)
    .map((call) => ({
      method: call.method_name,
      attachedDeposit: String(call.deposit),
      args: decodeArgs(call.args),
    }));
  if (calls.length !== 1 || !["deposit", "anchor_ledger_root", "withdraw"].includes(calls[0].method)) {
    throw new Error(`${input.label} contains an unexpected action`);
  }
  const logs = outcome.receipts_outcome.flatMap((receipt) => receipt.outcome.logs).map(parseEventLog);
  assertNoPrivateDealData({ calls, logs }, input.label);
  return {
    label: input.label,
    hash: input.hash,
    signerId: outcome.transaction.signer_id,
    receiverId: outcome.transaction.receiver_id,
    blockHash: outcome.transaction_outcome?.block_hash,
    calls,
    logs,
    status: "SUCCESS",
  };
}

for (const input of expected) {
  const transaction = transactions.find((item) => item.hash === input.hash);
  if (!transaction || transaction.calls[0].method !== input.expectedMethod) {
    throw new Error(`${input.label} was not found with method ${input.expectedMethod}`);
  }
}

const config = await viewFunction(rpcUrl, contractId, "get_config");
if (config.paused !== false) throw new Error("Pool is not unpaused after the live deal");
if (!/^[0-9a-f]{64}$/.test(config.latest_ledger_root) || BigInt(config.latest_ledger_sequence) < 1n) {
  throw new Error("Live ledger-root anchoring was not observed");
}

const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  explorerSource: historyUrl.origin,
  contractId,
  workerId,
  transactionCount: transactions.length,
  transactions,
  finalLedger: {
    sequence: config.latest_ledger_sequence,
    root: config.latest_ledger_root,
    poolLiabilityAtomic: config.pool_liability,
  },
  privacyInspection: {
    passed: true,
    forbiddenPrivateFieldsFound: [],
    publicFieldsExpected: ["depositor", "deposit amount", "commitment", "ledger root", "withdrawal recipient", "withdrawal amount"],
  },
};
await writeEvidence(output, evidence);
process.stdout.write(`${JSON.stringify({
  ok: true,
  output,
  transactionCount: evidence.transactionCount,
  rootAnchors: transactions.filter((item) => item.calls[0].method === "anchor_ledger_root").length,
  withdrawals: transactions.filter((item) => item.calls[0].method === "withdraw").length,
  finalLedger: evidence.finalLedger,
  privacyInspection: evidence.privacyInspection,
}, null, 2)}\n`);

function publicInput(label, hashName, signerName, expectedMethod) {
  return {
    label,
    hash: requireTransactionHash(required(hashName), hashName),
    signerId: requireAccount(required(signerName), signerName),
    expectedMethod,
  };
}

function requireTransactionHash(value, name) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function uniqueByHash(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.hash)) continue;
    seen.add(item.hash);
    result.push(item);
  }
  return result;
}

function decodeArgs(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("Transaction function-call arguments are invalid");
  }
}

function parseEventLog(value) {
  if (!value.startsWith("EVENT_JSON:")) return { raw: value };
  try {
    return JSON.parse(value.slice("EVENT_JSON:".length));
  } catch {
    throw new Error("Contract event log is invalid");
  }
}

function assertNoPrivateDealData(value, label) {
  const serialized = JSON.stringify(value).toLowerCase();
  const forbidden = [
    "ticket_id", "ticketref", "deal_id", "terms_hash", "price_atomic",
    "buyer_collateral", "seller_collateral", "delivery_commitment", "product",
    "credential", "private_balance",
  ];
  const found = forbidden.filter((field) => serialized.includes(field));
  if (found.length > 0) throw new Error(`${label} exposed private deal fields: ${found.join(", ")}`);
}

function isSuccess(status) {
  return typeof status === "object" && status !== null
    && (Object.hasOwn(status, "SuccessValue") || Object.hasOwn(status, "SuccessReceiptId"));
}
