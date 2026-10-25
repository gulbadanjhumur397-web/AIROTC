import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { baseDecode, KeyPair } from "near-api-js";
import {
  base64UrlToBytes,
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  createDepositCommitment,
  workerEncryptionKeyHash,
} from "../shared-types/dist/index.js";
import { requireAccount, sha256 } from "./phase9-lib.mjs";

const CONFIRMATION = "PREPARE_AIROTC_TESTNET_ENVIRONMENT";
if (process.env.CONFIRM_TESTNET_ENVIRONMENT !== CONFIRMATION) {
  throw new Error(`Set CONFIRM_TESTNET_ENVIRONMENT=${CONFIRMATION} to generate the ignored testnet secret files`);
}

const walletPath = resolve(process.env.AIROTC_TESTNET_WALLETS_FILE ?? ".secrets/testnet-wallets.json");
const outputPath = resolve(process.env.AIROTC_TESTNET_ENV_FILE ?? ".secrets/testnet.env");
const buyerAgentPath = resolve(process.env.DEMO_BUYER_AGENT_FILE ?? ".secrets/buyer-agent.env");
const sellerAgentPath = resolve(process.env.DEMO_SELLER_AGENT_FILE ?? ".secrets/seller-agent.env");
const buyerDepositPath = resolve(process.env.DEMO_BUYER_DEPOSIT_FILE ?? ".secrets/buyer-deposit.env");
const sellerDepositPath = resolve(process.env.DEMO_SELLER_DEPOSIT_FILE ?? ".secrets/seller-deposit.env");
const wallets = JSON.parse(await readFile(walletPath, "utf8"));
const entries = {};
for (const role of ["owner", "pool", "worker", "buyer", "seller"]) {
  const entry = wallets.accounts?.[role];
  if (!entry) throw new Error(`Wallet file is missing ${role}`);
  requireAccount(entry.accountId, `${role} account`);
  const pair = KeyPair.fromString(entry.privateKey);
  if (pair.getPublicKey().toString() !== entry.publicKey) throw new Error(`${role} wallet key mismatch`);
  entries[role] = entry;
}

const workerPair = KeyPair.fromRandom("ed25519");
const boxSecret = randomBytes(32);
const encryptionKeyId = "airotc-tee-key-v1";
const identity = {
  workerId: entries.worker.accountId,
  encryptionKeyId,
  encryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(boxSecret)),
};
const encryptionKeyHash = workerEncryptionKeyHash(identity);
const provisionalMeasurementHash = sha256(`airotc:pending-near-cloud-tee-attestation:v1:${entries.pool.accountId}`);
const buyerDepositSecret = randomBytes(32).toString("base64url");
const sellerDepositSecret = randomBytes(32).toString("base64url");

const buyerAgent = agentEnvironment("BUYER", entries.buyer);
const sellerAgent = agentEnvironment("SELLER", entries.seller);
await writeNewSecret(buyerAgentPath, buyerAgent.text);
await writeNewSecret(sellerAgentPath, sellerAgent.text);
await writeNewSecret(buyerDepositPath, `DEMO_BUYER_DEPOSIT_SECRET=${buyerDepositSecret}\n`);
await writeNewSecret(sellerDepositPath, `DEMO_SELLER_DEPOSIT_SECRET=${sellerDepositSecret}\n`);

const envLines = [
  "NEAR_RPC_URL=https://rpc.testnet.near.org",
  `NEAR_OWNER_ACCOUNT_ID=${entries.owner.accountId}`,
  `NEAR_POOL_CONTRACT_ID=${entries.pool.accountId}`,
  `TEE_NEAR_ACCOUNT_ID=${entries.worker.accountId}`,
  `DEMO_BUYER_ACCOUNT_ID=${entries.buyer.accountId}`,
  `DEMO_SELLER_ACCOUNT_ID=${entries.seller.accountId}`,
  "PRIVACY_API_URL=",
  "TEE_WORKER_URL=",
  "WEB_ORIGIN=",
  `TEE_MEASUREMENT_HASH=${provisionalMeasurementHash}`,
  "TEE_IDENTITY_PROVISIONAL=true",
  `TEE_ENCRYPTION_KEY_HASH=${encryptionKeyHash}`,
  `TEE_WORKER_PUBLIC_KEY=${workerPair.getPublicKey().toString()}`,
  "TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM=false",
  "TEE_WORKER_IMAGE=",
  `TEE_ENCRYPTION_KEY_ID=${encryptionKeyId}`,
  "POOL_MIN_DEPOSIT_ATOMIC=1000000000000000000000",
  "POOL_MAX_WITHDRAWAL_ATOMIC=10000000000000000000000000",
  "POOL_WINDOW_LIMIT_ATOMIC=50000000000000000000000000",
  "POOL_WINDOW_NS=3600000000000",
  "POOL_ROTATION_DELAY_NS=60000000000",
  `NEAR_OWNER_PRIVATE_KEY=${entries.owner.privateKey}`,
  `NEAR_POOL_PRIVATE_KEY=${entries.pool.privateKey}`,
  `WORKER_BOOTSTRAP_PRIVATE_KEY=${entries.worker.privateKey}`,
  `TEE_NEAR_PRIVATE_KEY=${workerPair.toString()}`,
  `TEE_BOX_SECRET_KEY_B64URL=${bytesToBase64Url(boxSecret)}`,
  `TEE_LEDGER_KEY_B64URL=${randomBytes(32).toString("base64url")}`,
  `PRIVACY_API_DATABASE_KEY_B64URL=${randomBytes(32).toString("base64url")}`,
  `PRIVACY_API_HANDLE_SECRET_B64URL=${randomBytes(32).toString("base64url")}`,
  `DEMO_BUYER_NEAR_PRIVATE_KEY=${entries.buyer.privateKey}`,
  `DEMO_SELLER_NEAR_PRIVATE_KEY=${entries.seller.privateKey}`,
  ...buyerAgent.lines,
  ...sellerAgent.lines,
  `DEMO_BUYER_DEPOSIT_SECRET=${buyerDepositSecret}`,
  `DEMO_SELLER_DEPOSIT_SECRET=${sellerDepositSecret}`,
  "DEMO_PRICE_ATOMIC=100000000000000000000000",
  "DEMO_BUYER_COLLATERAL_ATOMIC=20000000000000000000000",
  "DEMO_SELLER_COLLATERAL_ATOMIC=20000000000000000000000",
  "DEMO_BUYER_WITHDRAW_ATOMIC=1000000000000000000",
  "DEMO_SELLER_WITHDRAW_ATOMIC=1000000000000000000",
  "DEMO_PRODUCT_PUBLIC_LABEL=AIR_OTC_test_API_access",
  "DEMO_PRODUCT_VALIDATION_URL=",
  `DEMO_PRODUCT_SECRET=${randomBytes(32).toString("base64url")}`,
  "PHASE9_EVIDENCE_FILE=evidence/two-agent-testnet.json",
  "",
];
await writeNewSecret(outputPath, envLines.join("\n"));

process.stdout.write(`${JSON.stringify({
  ok: true,
  networkId: "testnet",
  accounts: Object.fromEntries(Object.entries(entries).map(([role, entry]) => [role, entry.accountId])),
  workerPublicKey: workerPair.getPublicKey().toString(),
  encryptionIdentity: identity,
  encryptionKeyHash,
  provisionalMeasurementHash,
  provisionalIdentity: true,
  operationalKeyStatus: "LOCAL_STAGING_ONLY_REPLACE_DURING_CVM_PROVISIONING",
  contractMustRemainPaused: true,
  buyerDepositCommitment: createDepositCommitment(buyerDepositSecret),
  sellerDepositCommitment: createDepositCommitment(sellerDepositSecret),
  files: {
    environment: outputPath,
    buyerAgent: buyerAgentPath,
    sellerAgent: sellerAgentPath,
    buyerDeposit: buyerDepositPath,
    sellerDeposit: sellerDepositPath,
  },
}, null, 2)}\n`);

function agentEnvironment(role, entry) {
  const decoded = baseDecode(entry.privateKey.slice("ed25519:".length));
  if (decoded.length !== 64) throw new Error(`${role} wallet private key is not an extended Ed25519 key`);
  const signingSeed = Buffer.from(decoded.slice(0, 32)).toString("base64url");
  const prefix = `DEMO_${role}`;
  const lines = [
    `${prefix}_ACCOUNT_ID=${entry.accountId}`,
    `${prefix}_SIGNING_SEED_B64URL=${signingSeed}`,
    `${prefix}_BOX_SECRET_B64URL=${randomBytes(32).toString("base64url")}`,
    `${prefix}_BOX_KEY_ID=demo-${role.toLowerCase()}-box-v1`,
  ];
  return { lines, text: `${lines.join("\n")}\n` };
}

async function writeNewSecret(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}
