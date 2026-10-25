import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { KeyPair } from "near-api-js";
import { sha256Bytes } from "../shared-types/dist/index.js";
import { nep413Payload } from "../privacy-api/dist/token-service.js";
import { requireAccount, requireAtomic, required } from "./phase9-lib.mjs";

const apiUrl = new URL(required("PRIVACY_API_URL"));
if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "127.0.0.1" && apiUrl.hostname !== "localhost") {
  throw new Error("PRIVACY_API_URL must use HTTPS outside local development");
}
const accountId = requireAccount(required("TOKEN_ACCOUNT_ID"), "TOKEN_ACCOUNT_ID");
const privateKey = required("TOKEN_ACCOUNT_PRIVATE_KEY");
const role = required("TOKEN_ROLE").toUpperCase();
if (role !== "BUYER" && role !== "SELLER") throw new Error("TOKEN_ROLE must be BUYER or SELLER");
const outputPath = resolve(required("TOKEN_OUTPUT_FILE"));
const now = BigInt(Date.now()) * 1_000_000n;
const expiresAtNs = process.env.TOKEN_EXPIRES_AT_NS ?? (now + 24n * 60n * 60n * 1_000_000_000n).toString();
requireAtomic(expiresAtNs, "TOKEN_EXPIRES_AT_NS", false);
const scopes = role === "BUYER"
  ? ["marketplace:read", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write", "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke"]
  : ["marketplace:read", "marketplace:write", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke"];
const grant = {
  version: 1,
  walletId: accountId,
  scopes,
  roles: [role],
  policy: {
    maxWithdrawalAtomic: requireAtomic(process.env.TOKEN_MAX_WITHDRAWAL_ATOMIC ?? "10000000000000000000000000", "TOKEN_MAX_WITHDRAWAL_ATOMIC", false),
    maxCumulativeWithdrawalAtomic: requireAtomic(process.env.TOKEN_MAX_CUMULATIVE_WITHDRAWAL_ATOMIC ?? "20000000000000000000000000", "TOKEN_MAX_CUMULATIVE_WITHDRAWAL_ATOMIC", false),
  },
  expiresAtNs,
};
if (BigInt(grant.policy.maxCumulativeWithdrawalAtomic) < BigInt(grant.policy.maxWithdrawalAtomic)) {
  throw new Error("Cumulative withdrawal policy must be at least the per-action policy");
}

const challengeResponse = await fetch(new URL("/v1/auth/challenge", apiUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(grant),
  signal: AbortSignal.timeout(20_000),
});
const challenge = await challengeResponse.json();
if (!challengeResponse.ok) throw new Error(`Token challenge failed: ${safeApiError(challenge)}`);
const keyPair = KeyPair.fromString(privateKey);
const payload = nep413Payload({
  message: challenge.message,
  nonce: new Uint8Array(Buffer.from(challenge.nonce, "base64")),
  recipient: challenge.recipient,
});
const signature = keyPair.sign(sha256Bytes(payload)).signature;
const tokenResponse = await fetch(new URL("/v1/auth/token", apiUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    challengeId: challenge.challengeId,
    accountId,
    publicKey: keyPair.getPublicKey().toString(),
    signature: Buffer.from(signature).toString("base64"),
  }),
  signal: AbortSignal.timeout(20_000),
});
const issued = await tokenResponse.json();
if (!tokenResponse.ok || typeof issued.token !== "string") throw new Error(`Token issuance failed: ${safeApiError(issued)}`);

const variable = role === "BUYER" ? "DEMO_BUYER_MCP_TOKEN" : "DEMO_SELLER_MCP_TOKEN";
const handle = await open(outputPath, "wx", 0o600);
try { await handle.writeFile(`${variable}=${issued.token}\n`); } finally { await handle.close(); }
process.stdout.write(`${JSON.stringify({
  accountId,
  role,
  tokenId: issued.tokenId,
  scopes: issued.scopes,
  expiresAtNs: issued.expiresAtNs,
  tokenFile: outputPath,
}, null, 2)}\n`);

function safeApiError(value) {
  const message = value?.error?.message;
  return typeof message === "string" && /^[A-Za-z0-9 _.:/-]{1,200}$/.test(message) ? message : "request rejected";
}
