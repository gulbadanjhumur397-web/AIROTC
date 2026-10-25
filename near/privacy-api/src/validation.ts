import {
  base64UrlToBytes,
  isSha256Hex,
  type EncryptedEnvelopeV1,
} from "@air-otc/shared-types";
import type { PartyRole, Scope, SpendingPolicy } from "./types.js";

const MAX_U128 = (1n << 128n) - 1n;
const ENVELOPE_KEYS = [
  "version",
  "algorithm",
  "recipientKeyId",
  "context",
  "ephemeralPublicKey",
  "nonce",
  "ciphertext",
] as const;

export const ALL_SCOPES: readonly Scope[] = [
  "marketplace:read",
  "marketplace:write",
  "tickets:read",
  "tickets:write",
  "terms:submit",
  "pool:read",
  "pool:write",
  "delivery:read",
  "delivery:write",
  "withdrawals:write",
  "tokens:rotate",
  "tokens:revoke",
];

export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains missing or unsupported fields`);
  }
}

export function requireAccountId(value: unknown, field = "accountId"): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])$/.test(value)
  ) {
    throw new Error(`${field} is not a valid NEAR account ID`);
  }
  return value;
}

export function requireAtomic(value: unknown, field: string, allowZero = true): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical atomic-unit string`);
  }
  const amount = BigInt(value);
  if (!allowZero && amount === 0n) throw new Error(`${field} must be greater than zero`);
  if (amount > MAX_U128) throw new Error(`${field} exceeds u128`);
  return value;
}

export function requireOpaqueRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z]+_[A-Za-z0-9_-]{22,64}$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function requireKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function requireBoxPublicKey(value: unknown, field: string): string {
  if (typeof value !== "string" || base64UrlToBytes(value).length !== 32) throw new Error(`${field} must encode 32 bytes`);
  return value;
}

export function requireEnvelope(value: unknown, context: string): EncryptedEnvelopeV1 {
  const object = requireRecord(value, "encrypted envelope");
  requireExactKeys(object, ENVELOPE_KEYS, "encrypted envelope");
  if (object.version !== 1 || object.algorithm !== "x25519-xsalsa20-poly1305") {
    throw new Error("Unsupported encrypted envelope");
  }
  if (object.context !== context) throw new Error("Encrypted envelope context is invalid");
  const recipientKeyId = requireKey(object.recipientKeyId, "recipientKeyId");
  const ephemeralPublicKey = requireBoxPublicKey(object.ephemeralPublicKey, "ephemeralPublicKey");
  if (typeof object.nonce !== "string" || base64UrlToBytes(object.nonce).length !== 24) {
    throw new Error("Encrypted envelope nonce must encode 24 bytes");
  }
  if (typeof object.ciphertext !== "string" || object.ciphertext.length < 22 || object.ciphertext.length > 350_000) {
    throw new Error("Encrypted envelope ciphertext is invalid");
  }
  base64UrlToBytes(object.ciphertext);
  return {
    version: 1,
    algorithm: "x25519-xsalsa20-poly1305",
    recipientKeyId,
    context,
    ephemeralPublicKey,
    nonce: object.nonce,
    ciphertext: object.ciphertext,
  };
}

export function requireHashList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((entry) => !isSha256Hex(entry))) {
    throw new Error("tagHashes must contain at most 16 SHA-256 hashes");
  }
  return [...new Set(value as string[])].sort();
}

export function requireScopes(value: unknown): Scope[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((scope) => !ALL_SCOPES.includes(scope as Scope))) {
    throw new Error("Token scopes are invalid");
  }
  return [...new Set(value as Scope[])].sort();
}

export function requireRoles(value: unknown): PartyRole[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((role) => role !== "BUYER" && role !== "SELLER")) {
    throw new Error("Token roles are invalid");
  }
  return [...new Set(value as PartyRole[])].sort();
}

export function requirePolicy(value: unknown): SpendingPolicy {
  const object = requireRecord(value, "spending policy");
  requireExactKeys(object, ["maxWithdrawalAtomic", "maxCumulativeWithdrawalAtomic"], "spending policy");
  const maxWithdrawalAtomic = requireAtomic(object.maxWithdrawalAtomic, "maxWithdrawalAtomic");
  const maxCumulativeWithdrawalAtomic = requireAtomic(object.maxCumulativeWithdrawalAtomic, "maxCumulativeWithdrawalAtomic");
  if (BigInt(maxWithdrawalAtomic) > BigInt(maxCumulativeWithdrawalAtomic)) {
    throw new Error("Per-withdrawal cap exceeds cumulative cap");
  }
  return { maxWithdrawalAtomic, maxCumulativeWithdrawalAtomic };
}

export function requireHash(value: unknown, field: string): string {
  if (!isSha256Hex(value)) throw new Error(`${field} must be a SHA-256 hash`);
  return value;
}
