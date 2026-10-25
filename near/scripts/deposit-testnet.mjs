import { Account, JsonRpcProvider } from "near-api-js";
import { createDepositCommitment } from "../shared-types/dist/index.js";
import { assertTestnetChain, explorerTransaction, requireAccount, requireAtomic, required, requireTestnetRpc, writeEvidence } from "./phase9-lib.mjs";

if (process.env.CONFIRM_TESTNET_DEPOSIT !== "DEPOSIT_AIROTC_TESTNET") {
  throw new Error("Set CONFIRM_TESTNET_DEPOSIT=DEPOSIT_AIROTC_TESTNET to authorize the testnet deposit");
}
const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
await assertTestnetChain(rpcUrl);
const accountId = requireAccount(required("DEPOSITOR_ACCOUNT_ID"), "DEPOSITOR_ACCOUNT_ID");
const contractId = requireAccount(required("NEAR_POOL_CONTRACT_ID"), "NEAR_POOL_CONTRACT_ID");
const privateKey = required("DEPOSITOR_PRIVATE_KEY");
const secret = required("DEPOSIT_SECRET");
if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("DEPOSIT_SECRET must be 32-byte base64url");
const amount = requireAtomic(required("DEPOSIT_AMOUNT_ATOMIC"), "DEPOSIT_AMOUNT_ATOMIC", false);
const commitment = createDepositCommitment(secret);
const provider = new JsonRpcProvider({ url: rpcUrl });
const account = new Account(accountId, provider, privateKey);
const outcome = await account.callFunctionRaw({
  contractId,
  methodName: "deposit",
  args: { commitment },
  gas: "30000000000000",
  deposit: amount,
  waitUntil: "FINAL",
});
const evidence = {
  generatedAt: new Date().toISOString(),
  network: "testnet",
  depositorAccountId: accountId,
  contractId,
  commitment,
  transactionHash: outcome.transaction.hash,
  explorerUrl: explorerTransaction(outcome.transaction.hash),
};
if (process.env.PHASE9_EVIDENCE_FILE) await writeEvidence(process.env.PHASE9_EVIDENCE_FILE, evidence);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
