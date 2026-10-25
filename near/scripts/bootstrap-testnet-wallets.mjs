import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { assertTestnetChain, requireTestnetRpc, rpc, viewRequest } from "./phase9-lib.mjs";

const CONFIRMATION = "CREATE_AIROTC_TESTNET_WALLETS";
if (process.env.CONFIRM_TESTNET_WALLET_BOOTSTRAP !== CONFIRMATION) {
  throw new Error(`Set CONFIRM_TESTNET_WALLET_BOOTSTRAP=${CONFIRMATION} to create faucet-funded testnet accounts`);
}

const rpcUrl = requireTestnetRpc(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org");
const faucetUrl = new URL(process.env.NEAR_TESTNET_FAUCET_URL ?? "https://helper.nearprotocol.com/account");
if (faucetUrl.protocol !== "https:") throw new Error("NEAR_TESTNET_FAUCET_URL must use HTTPS");
if (!["helper.nearprotocol.com", "helper.testnet.near.org"].includes(faucetUrl.hostname)) {
  throw new Error("Refusing an unrecognized NEAR testnet faucet host");
}

const secretPath = resolve(process.env.AIROTC_TESTNET_WALLETS_FILE ?? ".secrets/testnet-wallets.json");
const publicPath = resolve(process.env.AIROTC_TESTNET_ACCOUNTS_FILE ?? "evidence/testnet-accounts.json");
const roles = ["owner", "pool", "worker", "buyer", "seller"];

await assertTestnetChain(rpcUrl);
const wallet = await loadOrCreateWallet();

for (const role of roles) {
  const entry = wallet.accounts[role];
  const existing = await readAccount(entry.accountId);
  if (existing) {
    await verifyAccessKey(entry.accountId, entry.publicKey);
    entry.status = "ready";
    entry.balanceAtomic = existing.amount;
    await saveWallet(wallet);
    continue;
  }

  const response = await fetch(faucetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      newAccountId: entry.accountId,
      newAccountPublicKey: entry.publicKey.replace(/^ed25519:/, ""),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`NEAR testnet faucet rejected ${entry.accountId}: HTTP ${response.status} ${safeText(body)}`);
  }

  const created = await waitForAccount(entry.accountId);
  await verifyAccessKey(entry.accountId, entry.publicKey);
  entry.status = "ready";
  entry.balanceAtomic = created.amount;
  entry.faucetResponse = parseSafeResponse(body);
  await saveWallet(wallet);
}

const publicManifest = {
  networkId: "testnet",
  rpcUrl,
  generatedAt: wallet.generatedAt,
  accounts: Object.fromEntries(roles.map((role) => {
    const entry = wallet.accounts[role];
    return [role, {
      accountId: entry.accountId,
      publicKey: entry.publicKey,
      balanceAtomic: entry.balanceAtomic,
    }];
  })),
};
await mkdir(dirname(publicPath), { recursive: true });
await writeFile(publicPath, `${JSON.stringify(publicManifest, null, 2)}\n`, { mode: 0o600 });
await chmod(publicPath, 0o600);

process.stdout.write(`${JSON.stringify({
  ok: true,
  networkId: "testnet",
  accounts: Object.fromEntries(roles.map((role) => [role, {
    accountId: wallet.accounts[role].accountId,
    publicKey: wallet.accounts[role].publicKey,
    balanceAtomic: wallet.accounts[role].balanceAtomic,
  }])),
  secretFile: secretPath,
  publicManifest: publicPath,
}, null, 2)}\n`);

async function loadOrCreateWallet() {
  try {
    const saved = JSON.parse(await readFile(secretPath, "utf8"));
    if (saved.networkId !== "testnet" || !saved.accounts) throw new Error("Invalid wallet file");
    for (const role of roles) {
      const entry = saved.accounts[role];
      if (!entry?.accountId || !entry?.publicKey || !entry?.privateKey) {
        throw new Error(`Wallet file is missing ${role}`);
      }
      const keyPair = KeyPair.fromString(entry.privateKey);
      if (keyPair.getPublicKey().toString() !== entry.publicKey) {
        throw new Error(`Wallet file contains a mismatched ${role} key`);
      }
    }
    await chmod(secretPath, 0o600);
    return saved;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const suffix = randomBytes(4).toString("hex");
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const accounts = {};
  for (const role of roles) {
    const keyPair = KeyPair.fromRandom("ed25519");
    accounts[role] = {
      accountId: `airotc-hackathon-${role}-${date}-${suffix}.testnet`,
      publicKey: keyPair.getPublicKey().toString(),
      privateKey: keyPair.toString(),
      status: "generated",
    };
  }
  const created = { networkId: "testnet", generatedAt: new Date().toISOString(), accounts };
  await mkdir(dirname(secretPath), { recursive: true });
  const handle = await open(secretPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(created, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await chmod(secretPath, 0o600);
  return created;
}

async function saveWallet(value) {
  const temporary = `${secretPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, secretPath);
  await chmod(secretPath, 0o600);
}

async function readAccount(accountId) {
  try {
    return await rpc(rpcUrl, "query", viewRequest(accountId, "view_account"));
  } catch (error) {
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(String(error))) return null;
    throw error;
  }
}

async function waitForAccount(accountId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const account = await readAccount(accountId);
    if (account) return account;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Faucet returned success but ${accountId} was not visible on testnet`);
}

async function verifyAccessKey(accountId, publicKey) {
  const result = await rpc(rpcUrl, "query", viewRequest(accountId, "view_access_key_list"));
  if (!result.keys.some((item) => item.public_key === publicKey && item.access_key.permission === "FullAccess")) {
    throw new Error(`${accountId} does not contain the expected FullAccess key`);
  }
}

function parseSafeResponse(body) {
  try {
    const value = JSON.parse(body);
    if (typeof value === "object" && value !== null) {
      const safe = {};
      for (const key of ["account_id", "accountId", "transaction_hash", "transactionHash", "status"]) {
        if (value[key] !== undefined) safe[key] = value[key];
      }
      return safe;
    }
  } catch {
    // The faucet can return plain text. It is not needed after on-chain verification.
  }
  return {};
}

function safeText(value) {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}
