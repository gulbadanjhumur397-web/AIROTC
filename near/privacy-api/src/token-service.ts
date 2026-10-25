import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha256Bytes } from "@air-otc/shared-types";
import type {
  ApiStateV1,
  AuthContext,
  Clock,
  IdentityVerifier,
  PartyRole,
  Scope,
  SpendingPolicy,
  TokenRecord,
} from "./types.js";
import { requireAccountId, requireExactKeys, requirePolicy, requireRoles, requireScopes } from "./validation.js";

export const NEP413_TAG = 2 ** 31 + 413;
export const TOKEN_RECIPIENT = "air-otc-near-mcp";
const TOKEN_PREFIX = "airotc_near_";
const MAX_TOKEN_LIFETIME_NS = 30n * 24n * 60n * 60n * 1_000_000_000n;

export interface TokenGrant {
  version: 1;
  walletId: string;
  scopes: Scope[];
  roles: PartyRole[];
  policy: SpendingPolicy;
  expiresAtNs: string;
}

export interface TokenChallenge extends TokenGrant {
  challengeId: string;
  message: string;
  recipient: typeof TOKEN_RECIPIENT;
  nonce: string;
  challengeExpiresAtNs: string;
}

export interface SignedTokenChallenge {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
}

export class TokenAuthorizationError extends Error {}

interface PendingChallenge {
  challenge: TokenChallenge;
  nonceBytes: Uint8Array;
  used: boolean;
}

export class TokenService {
  private readonly challenges = new Map<string, PendingChallenge>();

  constructor(
    private readonly identityVerifier: IdentityVerifier,
    private readonly clock: Clock,
    private readonly handleSecret: Uint8Array,
  ) {
    if (handleSecret.length < 32) throw new Error("Handle secret must contain at least 32 bytes");
  }

  createChallenge(value: unknown): TokenChallenge {
    const grant = normalizeGrant(value, this.clock.nowNs());
    const challengeId = `challenge_${randomBytes(18).toString("base64url")}`;
    const nonceBytes = randomBytes(32);
    const challengeExpiresAtNs = (this.clock.nowNs() + 5n * 60n * 1_000_000_000n).toString();
    const message = JSON.stringify({
      domain: "airotc:mcp-token-grant:v1",
      challengeId,
      ...grant,
      challengeExpiresAtNs,
    });
    const challenge: TokenChallenge = {
      ...grant,
      challengeId,
      message,
      recipient: TOKEN_RECIPIENT,
      nonce: Buffer.from(nonceBytes).toString("base64"),
      challengeExpiresAtNs,
    };
    this.challenges.set(challengeId, { challenge, nonceBytes, used: false });
    return challenge;
  }

  async issueFromChallenge(state: ApiStateV1, proof: SignedTokenChallenge): Promise<{ token: string; record: TokenRecord }> {
    const pending = this.challenges.get(proof.challengeId);
    if (!pending || pending.used) throw new Error("Token challenge is missing or already used");
    if (BigInt(pending.challenge.challengeExpiresAtNs) <= this.clock.nowNs()) throw new Error("Token challenge expired");
    if (proof.accountId !== pending.challenge.walletId) throw new Error("Token challenge wallet mismatch");
    if (!(await this.identityVerifier.isAuthorizedKey(proof.accountId, proof.publicKey))) {
      throw new Error("Signing key is not authorized for this NEAR account");
    }
    if (!verifyNep413({
      message: pending.challenge.message,
      recipient: pending.challenge.recipient,
      nonce: pending.nonceBytes,
      publicKey: proof.publicKey,
      signature: proof.signature,
    })) {
      throw new Error("Invalid NEP-413 token signature");
    }
    pending.used = true;
    return this.issue(state, pending.challenge, 0);
  }

  issueForTesting(state: ApiStateV1, grant: TokenGrant): { token: string; record: TokenRecord } {
    return this.issue(state, normalizeGrant(grant, this.clock.nowNs()), 0);
  }

  authenticate(state: ApiStateV1, rawToken: string): AuthContext {
    if (!rawToken.startsWith(TOKEN_PREFIX) || rawToken.length < 40 || rawToken.length > 128) throw new Error("Invalid MCP token");
    const hash = tokenHash(rawToken);
    const record = Object.values(state.tokens).find((candidate) => safeEqual(candidate.tokenHash, hash));
    if (!record || record.revokedAtNs !== "") throw new Error("Invalid or revoked MCP token");
    if (BigInt(record.expiresAtNs) <= this.clock.nowNs()) throw new Error("MCP token expired");
    return context(record);
  }

  rotate(state: ApiStateV1, auth: AuthContext): { token: string; record: TokenRecord } {
    this.requireScope(auth, "tokens:rotate");
    const existing = state.tokens[auth.tokenId];
    if (!existing || existing.revokedAtNs !== "") throw new Error("Token cannot be rotated");
    existing.revokedAtNs = this.clock.nowNs().toString();
    return this.issue(state, {
      version: 1,
      walletId: existing.walletId,
      scopes: existing.scopes,
      roles: existing.roles,
      policy: existing.policy,
      expiresAtNs: existing.expiresAtNs,
    }, existing.rotation + 1);
  }

  revoke(state: ApiStateV1, auth: AuthContext): void {
    this.requireScope(auth, "tokens:revoke");
    const record = state.tokens[auth.tokenId];
    if (!record || record.revokedAtNs !== "") throw new Error("Token is already revoked");
    record.revokedAtNs = this.clock.nowNs().toString();
  }

  reserveWithdrawal(state: ApiStateV1, auth: AuthContext, amountAtomic: string): void {
    this.requireScope(auth, "withdrawals:write");
    const amount = BigInt(amountAtomic);
    if (amount > BigInt(auth.policy.maxWithdrawalAtomic)) throw new Error("Withdrawal exceeds token per-action policy");
    const record = state.tokens[auth.tokenId];
    if (!record) throw new Error("Token record is missing");
    const total = BigInt(record.withdrawnAtomic) + amount;
    if (total > BigInt(record.policy.maxCumulativeWithdrawalAtomic)) {
      throw new Error("Withdrawal exceeds token cumulative policy");
    }
    record.withdrawnAtomic = total.toString();
  }

  requireScope(auth: AuthContext, scope: Scope): void {
    if (!auth.scopes.has(scope)) throw new TokenAuthorizationError(`MCP token lacks ${scope}`);
  }

  requireRole(auth: AuthContext, role: PartyRole): void {
    if (!auth.roles.has(role)) throw new TokenAuthorizationError(`MCP token lacks ${role} role`);
  }

  handleForWallet(walletId: string): string {
    return createHmac("sha256", this.handleSecret).update(walletId).digest("hex");
  }

  private issue(state: ApiStateV1, grant: TokenGrant, rotation: number): { token: string; record: TokenRecord } {
    const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const tokenId = `token_${randomBytes(18).toString("base64url")}`;
    const record: TokenRecord = {
      tokenId,
      tokenHash: tokenHash(rawToken),
      walletId: grant.walletId,
      walletHandle: this.handleForWallet(grant.walletId),
      scopes: [...grant.scopes],
      roles: [...grant.roles],
      policy: { ...grant.policy },
      withdrawnAtomic: "0",
      createdAtNs: this.clock.nowNs().toString(),
      expiresAtNs: grant.expiresAtNs,
      revokedAtNs: "",
      rotation,
    };
    state.tokens[tokenId] = record;
    return { token: rawToken, record };
  }
}

export class NearRpcIdentityVerifier implements IdentityVerifier {
  constructor(private readonly rpcUrl: string) {}

  async isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "airotc-token-key-check",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("NEAR RPC identity check failed");
    const body = (await response.json()) as { result?: { permission?: unknown }; error?: unknown };
    return !body.error && body.result?.permission === "FullAccess";
  }
}

export class StaticIdentityVerifier implements IdentityVerifier {
  constructor(private readonly keys: ReadonlyMap<string, ReadonlySet<string>>) {}
  async isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.keys.get(accountId)?.has(publicKey) === true;
  }
}

export class SystemClock implements Clock {
  nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }
}

export function nep413Payload(input: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  if (input.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const callback = input.callbackUrl;
  return concat(
    u32(NEP413_TAG),
    borshString(input.message),
    input.nonce,
    borshString(input.recipient),
    callback === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), borshString(callback)),
  );
}

export function verifyNep413(input: {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  publicKey: string;
  signature: string;
  callbackUrl?: string;
}): boolean {
  if (!input.publicKey.startsWith("ed25519:")) return false;
  const publicKey = bs58.decode(input.publicKey.slice("ed25519:".length));
  const explicitlyBase58 = input.signature.startsWith("ed25519:");
  const signatureText = explicitlyBase58 ? input.signature.slice("ed25519:".length) : input.signature;
  let signature: Uint8Array;
  try {
    signature = explicitlyBase58
      ? bs58.decode(signatureText)
      : new Uint8Array(Buffer.from(signatureText, "base64"));
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const payload = nep413Payload({
    message: input.message,
    nonce: input.nonce,
    recipient: input.recipient,
    ...(input.callbackUrl === undefined ? {} : { callbackUrl: input.callbackUrl }),
  });
  return nacl.sign.detached.verify(sha256Bytes(payload), signature, publicKey);
}

function normalizeGrant(value: unknown, now: bigint): TokenGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Token grant must be an object");
  const input = value as Record<string, unknown>;
  requireExactKeys(input, ["version", "walletId", "scopes", "roles", "policy", "expiresAtNs"], "token grant");
  if (input.version !== 1) throw new Error("Unsupported token grant version");
  const walletId = requireAccountId(input.walletId, "walletId");
  const scopes = requireScopes(input.scopes);
  const roles = requireRoles(input.roles);
  const policy = requirePolicy(input.policy);
  if (typeof input.expiresAtNs !== "string" || !/^[1-9][0-9]*$/.test(input.expiresAtNs)) throw new Error("Token expiry is invalid");
  const expiry = BigInt(input.expiresAtNs);
  if (expiry <= now || expiry - now > MAX_TOKEN_LIFETIME_NS) throw new Error("Token lifetime is outside the allowed range");
  return { version: 1, walletId, scopes, roles, policy, expiresAtNs: input.expiresAtNs };
}

function context(record: TokenRecord): AuthContext {
  return {
    tokenId: record.tokenId,
    walletId: record.walletId,
    walletHandle: record.walletHandle,
    scopes: new Set(record.scopes),
    roles: new Set(record.roles),
    policy: { ...record.policy },
    withdrawnAtomic: record.withdrawnAtomic,
    expiresAtNs: record.expiresAtNs,
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function borshString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(u32(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
