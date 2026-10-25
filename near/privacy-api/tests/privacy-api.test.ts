import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  bytesToBase64Url,
  encryptJsonForRecipient,
  generateBoxKeyPair,
  sha256Bytes,
  type EncryptedEnvelopeV1,
} from "@air-otc/shared-types";
import { EncryptedFileDatabase, MemoryDatabase } from "../src/store.js";
import { createPrivacyApiServer, type AuditEvent } from "../src/server.js";
import { PrivacyApiService, type WorkerProxy } from "../src/service.js";
import { nep413Payload, StaticIdentityVerifier, TokenService, type TokenGrant } from "../src/token-service.js";
import type { Clock, Scope } from "../src/types.js";

const now = 1_900_000_000_000_000_000n;
const clock: Clock = { nowNs: () => now };
const servers: ReturnType<typeof createPrivacyApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

class CapturingWorker implements WorkerProxy {
  termsSeen: EncryptedEnvelopeV1[] = [];
  actionsSeen: EncryptedEnvelopeV1[] = [];
  actionCommitments: Array<string | undefined> = [];
  fail = false;
  async identity() { return { workerId: "tee.testnet", encryptionKeyId: "tee-v1", encryptionPublicKey: "public" }; }
  async attestation(nonce: string) { return { binding: { nonce }, evidence: { platform: "TEST" } }; }
  async terms(envelope: EncryptedEnvelopeV1) { this.termsSeen.push(envelope); if (this.fail) throw new Error("offline"); return { envelope }; }
  async action(envelope: EncryptedEnvelopeV1, commitment?: string) { this.actionsSeen.push(envelope); this.actionCommitments.push(commitment); if (this.fail) throw new Error("offline"); return { envelope }; }
}

function grant(walletId: string, roles: Array<"BUYER" | "SELLER">, scopes: Scope[]): TokenGrant {
  return {
    version: 1,
    walletId,
    roles,
    scopes,
    policy: { maxWithdrawalAtomic: "1000", maxCumulativeWithdrawalAtomic: "1500" },
    expiresAtNs: (now + 1_000_000_000_000n).toString(),
  };
}

async function setup(database = new MemoryDatabase()) {
  const worker = new CapturingWorker();
  const tokens = new TokenService(new StaticIdentityVerifier(new Map()), clock, new Uint8Array(32).fill(9));
  const service = new PrivacyApiService(database, tokens, worker, clock);
  await service.initialize();
  const buyer = await service.issueTokenForTesting(grant("buyer.testnet", ["BUYER"], [
    "marketplace:read", "marketplace:write", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write",
    "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke",
  ]));
  const seller = await service.issueTokenForTesting(grant("seller.testnet", ["SELLER"], [
    "marketplace:read", "marketplace:write", "tickets:read", "tickets:write", "terms:submit", "pool:read",
    "pool:write", "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke",
  ]));
  return { service, worker, buyer, seller, database };
}

function envelope(key: ReturnType<typeof generateBoxKeyPair>, keyId: string, context: string, secret: string) {
  return encryptJsonForRecipient({ payload: { secret }, recipientPublicKey: key.publicKey, recipientKeyId: keyId, context });
}

describe("privacy API domain", () => {
  it("issues a wallet-bound token only after a valid NEP-413 signature and supports rotation/revocation", async () => {
    const seed = new Uint8Array(32).fill(4);
    const pair = nacl.sign.keyPair.fromSeed(seed);
    const publicKey = `ed25519:${bs58.encode(pair.publicKey)}`;
    const tokens = new TokenService(
      new StaticIdentityVerifier(new Map([["buyer.testnet", new Set([publicKey])]])),
      clock,
      new Uint8Array(32).fill(8),
    );
    const service = new PrivacyApiService(new MemoryDatabase(), tokens, new CapturingWorker(), clock);
    await service.initialize();
    const challenge = service.createTokenChallenge(grant("buyer.testnet", ["BUYER"], ["tokens:rotate", "tokens:revoke"]));
    const digest = sha256Bytes(nep413Payload({
      message: challenge.message,
      nonce: new Uint8Array(Buffer.from(challenge.nonce, "base64")),
      recipient: challenge.recipient,
    }));
    const issued = await service.issueToken({
      challengeId: challenge.challengeId,
      accountId: "buyer.testnet",
      publicKey,
      signature: Buffer.from(nacl.sign.detached(digest, pair.secretKey)).toString("base64"),
    });
    const raw = issued.token as string;
    expect(service.authenticate(raw).walletId).toBe("buyer.testnet");
    const rotated = await service.rotateToken(service.authenticate(raw), "request_token_rotation_001");
    expect(() => service.authenticate(raw)).toThrow("revoked");
    const next = rotated.token as string;
    await service.revokeToken(service.authenticate(next), "request_token_revocation_01");
    expect(() => service.authenticate(next)).toThrow("revoked");
  });

  it("isolates wallet roles, accepts only ciphertext, and rejects replay", async () => {
    const { service, buyer, seller } = await setup();
    const buyerAuth = service.authenticate(buyer.token);
    const sellerAuth = service.authenticate(seller.token);
    const sellerKey = generateBoxKeyPair();
    const buyerKey = generateBoxKeyPair();
    const listing = await service.createListing(sellerAuth, "request_listing_create_01", {
      kind: "API_ACCESS",
      tagHashes: ["a".repeat(64)],
      sellerEncryptionKeyId: "seller-box-v1",
      sellerEncryptionPublicKey: bytesToBase64Url(sellerKey.publicKey),
      encryptedProduct: envelope(sellerKey, "seller-box-v1", "airotc:listing:v1", "PRIVATE_API_PRODUCT"),
    });
    await expect(service.createListing(buyerAuth, "request_buyer_listing_001", {
      kind: "OTHER", tagHashes: [], sellerEncryptionKeyId: "buyer-box-v1",
      sellerEncryptionPublicKey: bytesToBase64Url(buyerKey.publicKey),
      encryptedProduct: envelope(buyerKey, "buyer-box-v1", "airotc:listing:v1", "x"),
    })).rejects.toThrow("SELLER");

    const ticket = await service.createTicket(buyerAuth, "request_ticket_create_001", {
      listingRef: listing.listingRef,
      buyerEncryptionKeyId: "buyer-box-v1",
      buyerEncryptionPublicKey: bytesToBase64Url(buyerKey.publicKey),
    });
    await service.addMessage(buyerAuth, "request_ticket_message_001", ticket.ticketRef, {
      buyerEnvelope: envelope(buyerKey, "buyer-box-v1", "airotc:ticket-message:v1", "PRIVATE_NEGOTIATION"),
      sellerEnvelope: envelope(sellerKey, "seller-box-v1", "airotc:ticket-message:v1", "PRIVATE_NEGOTIATION"),
    });
    await expect(service.addMessage(buyerAuth, "request_ticket_message_001", ticket.ticketRef, {
      buyerEnvelope: envelope(buyerKey, "buyer-box-v1", "airotc:ticket-message:v1", "replay"),
      sellerEnvelope: envelope(sellerKey, "seller-box-v1", "airotc:ticket-message:v1", "replay"),
    })).rejects.toMatchObject({ code: "REQUEST_REPLAY" });
    await service.putDelivery(sellerAuth, "request_delivery_store_001", ticket.ticketRef, {
      deliveryCommitment: "b".repeat(64),
      buyerEnvelope: envelope(buyerKey, "buyer-box-v1", "airotc:delivery:v1", "PRIVATE_DELIVERY_KEY"),
    });
    expect(service.getDelivery(buyerAuth, ticket.ticketRef)?.deliveryCommitment).toBe("b".repeat(64));
    await expect(() => service.getDelivery(sellerAuth, ticket.ticketRef)).toThrow("buyer");
    expect(service.listTickets(buyerAuth)).toHaveLength(1);
    expect(service.listTickets(sellerAuth)).toHaveLength(1);
  });

  it("forwards ciphertext unchanged and rolls back replay/policy state after worker failure", async () => {
    const { service, worker, buyer } = await setup();
    const auth = service.authenticate(buyer.token);
    const teeKey = generateBoxKeyPair();
    const terms = envelope(teeKey, "tee-box-v1", "airotc:terms-submission:v1", "PRIVATE_TERMS_PRICE_777");
    expect(await service.submitTerms(auth, "request_terms_submission_01", "BUYER", { envelope: terms })).toEqual({ envelope: terms });
    await expect(service.submitTerms(auth, "request_wrong_terms_role_01", "SELLER", { envelope: terms })).rejects.toThrow("SELLER role");
    expect(worker.termsSeen).toEqual([terms]);

    const action = envelope(teeKey, "tee-box-v1", "airotc:worker-action:v1", "PRIVATE_WITHDRAWAL");
    worker.fail = true;
    await expect(service.submitAction(auth, "request_withdrawal_retry_01", "withdrawals:write", { envelope: action }, "800")).rejects.toThrow("offline");
    worker.fail = false;
    await expect(service.submitAction(auth, "request_withdrawal_retry_01", "withdrawals:write", { envelope: action }, "800")).resolves.toEqual({ envelope: action });
    expect(worker.actionCommitments.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    await expect(service.submitAction(auth, "request_withdrawal_second_1", "withdrawals:write", { envelope: action }, "800")).rejects.toThrow("cumulative");
  });

  it("encrypts the complete database and detects tampering across restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airotc-api-"));
    const file = path.join(directory, "privacy.db");
    const key = new Uint8Array(32).fill(7);
    const database = new EncryptedFileDatabase(file, key);
    const { service, seller } = await setup(database);
    const sellerKey = generateBoxKeyPair();
    await service.createListing(service.authenticate(seller.token), "request_encrypted_store_01", {
      kind: "SERVICE", tagHashes: [], sellerEncryptionKeyId: "seller-store-key",
      sellerEncryptionPublicKey: bytesToBase64Url(sellerKey.publicKey),
      encryptedProduct: envelope(sellerKey, "seller-store-key", "airotc:listing:v1", "NEVER_PLAINTEXT_PRODUCT"),
    });
    const raw = await readFile(file, "utf8");
    for (const forbidden of ["NEVER_PLAINTEXT_PRODUCT", "seller.testnet", "maxWithdrawalAtomic", "tokenHash", "listings"]) {
      expect(raw).not.toContain(forbidden);
    }
    const restarted = await setup(new EncryptedFileDatabase(file, key));
    expect(restarted.service.listListings(restarted.service.authenticate(restarted.seller.token))).toHaveLength(1);
    const parsed = JSON.parse(raw) as { ciphertext: string };
    parsed.ciphertext = `${parsed.ciphertext.startsWith("A") ? "B" : "A"}${parsed.ciphertext.slice(1)}`;
    await writeFile(file, JSON.stringify(parsed));
    await expect(new EncryptedFileDatabase(file, key).load()).rejects.toThrow();
  });
});

describe("privacy API HTTP boundary", () => {
  it("rate limits requests and logs metadata without bodies, tokens, or query strings", async () => {
    const { service } = await setup();
    const logs: AuditEvent[] = [];
    const server = createPrivacyApiServer(service, { maxRequestsPerMinute: 1, logger: (event) => logs.push(event), allowedOrigin: "http://127.0.0.1:5173" });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const first = await fetch(`http://127.0.0.1:${port}/health?secret=NEVER_LOG`, { headers: { origin: "http://127.0.0.1:5173", authorization: "Bearer NEVER_LOG_TOKEN" } });
    const second = await fetch(`http://127.0.0.1:${port}/health`);
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(second.status).toBe(429);
    expect(JSON.stringify(logs)).not.toContain("NEVER_LOG");
    expect(logs.every((entry) => entry.path === "/health")).toBe(true);
  });
});

