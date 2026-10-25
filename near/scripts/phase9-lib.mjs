import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const TESTNET_RPC = "https://rpc.testnet.near.org";
export const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const ATOMIC_PATTERN = /^(0|[1-9][0-9]*)$/;

export function required(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function requireTestnetRpc(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("NEAR_RPC_URL must use HTTPS or a local test endpoint");
  }
  if (/mainnet/i.test(value)) throw new Error("Mainnet RPC is forbidden by the Phase 9 testnet scripts");
  return parsed.toString().replace(/\/$/, "");
}

export function requireAccount(value, field) {
  if (!ACCOUNT_PATTERN.test(value) || !value.endsWith(".testnet")) {
    throw new Error(`${field} must be a named .testnet account`);
  }
  return value;
}

export function requireHash(value, field) {
  if (!HASH_PATTERN.test(value)) throw new Error(`${field} must be 64 lowercase hexadecimal characters`);
  return value;
}

export function requireAtomic(value, field, allowZero = true) {
  if (!ATOMIC_PATTERN.test(value) || (!allowZero && BigInt(value) === 0n)) {
    throw new Error(`${field} must be a canonical ${allowZero ? "non-negative" : "positive"} atomic-unit integer`);
  }
  return value;
}

export async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "airotc-phase9", method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`NEAR RPC rejected ${method}: ${safeRpcMessage(body.error)}`);
  return body.result;
}

export async function assertTestnetChain(url) {
  const status = await rpc(url, "status", []);
  if (status.chain_id !== "testnet") throw new Error(`Expected NEAR testnet, received chain ${String(status.chain_id)}`);
  return status;
}

export function viewRequest(accountId, requestType, extra = {}) {
  return { request_type: requestType, finality: "final", account_id: accountId, ...extra };
}

export async function viewFunction(rpcUrl, contractId, methodName, args = {}) {
  const result = await rpc(rpcUrl, "query", viewRequest(contractId, "call_function", {
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  }));
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

export async function writeEvidence(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return absolute;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function explorerTransaction(hash) {
  return `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
}

function safeRpcMessage(error) {
  const text = JSON.stringify(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
