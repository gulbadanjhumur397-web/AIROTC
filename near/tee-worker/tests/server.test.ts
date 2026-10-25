import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  decryptJsonEnvelope,
  encryptJsonForRecipient,
  publicKeyFromSeed,
  signTerms,
  type FinalTermsV1,
} from "@air-otc/shared-types";
import { DevelopmentAttestationProvider } from "../src/attestation.js";
import { MemoryContractGateway } from "../src/contract-gateway.js";
import { StaticIdentityVerifier } from "../src/identity.js";
import { createWorkerServer } from "../src/server.js";
import { MemoryStateStore } from "../src/snapshot-store.js";
import type { Clock } from "../src/types.js";
import { ConfidentialWorker, TERMS_REQUEST_CONTEXT, WORKER_RESPONSE_CONTEXT } from "../src/worker.js";

const buyerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const buyerReplySecret = Uint8Array.from({ length: 32 }, (_, index) => index + 65);
const teeSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const now = 1_800_000_000_000_000_000n;
const clock: Clock = { nowNs: () => now };
const servers: ReturnType<typeof createWorkerServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        !server.listening
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
    ),
  );
});

async function startServer() {
  const buyerPublicKey = publicKeyFromSeed(buyerSeed);
  const worker = new ConfidentialWorker({
    workerId: "tee-worker.testnet",
    encryptionKeyId: "tee-key-v1",
    encryptionSecretKey: teeSecret,
    stateStore: new MemoryStateStore(),
    contract: new MemoryContractGateway(),
    identityVerifier: new StaticIdentityVerifier(new Map([["buyer.testnet", new Set([buyerPublicKey])]])),
    clock,
  });
  await worker.initialize();
  const logs: unknown[] = [];
  const server = createWorkerServer(worker, new DevelopmentAttestationProvider(), (entry) => logs.push(entry));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { worker, logs, baseUrl: `http://127.0.0.1:${address.port}` };
}

function privateTerms(): FinalTermsV1 {
  return {
    version: 1,
    ticketId: "ticket_01JHTTPBOUNDARY001",
    buyerId: "buyer.testnet",
    sellerId: "seller.testnet",
    assetDescriptionHash: "61aaf7411dc22392b475ac0f71a59c5ca6c2e3595b2e7741413f78f3912d2df1",
    currency: "NEAR_TESTNET",
    priceAtomic: "500",
    buyerCollateralAtomic: "100",
    sellerCollateralAtomic: "200",
    fundingDeadlineNs: (now + 10_000_000_000_000n).toString(),
    deliveryDeadlineNs: (now + 20_000_000_000_000n).toString(),
    confirmationDeadlineNs: (now + 30_000_000_000_000n).toString(),
    sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
    buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
    nonce: "agreement_nonce_http_00000001",
    expiresAtNs: (now + 1_000_000_000_000n).toString(),
  };
}

describe("confidential worker HTTP boundary", () => {
  it("publishes identity and handles an encrypted signed terms request", async () => {
    const { baseUrl } = await startServer();
    const identityResponse = await fetch(`${baseUrl}/v1/identity`);
    expect(identityResponse.status).toBe(200);
    expect(identityResponse.headers.get("cache-control")).toBe("no-store");
    const identity = (await identityResponse.json()) as Record<string, any>;
    expect(identity).toMatchObject({
      workerId: "tee-worker.testnet",
      encryptionKeyId: "tee-key-v1",
      attestationEndpoint: "/v1/attestation?nonce=<64-hex>",
    });
    const attestationResponse = await fetch(`${baseUrl}/v1/attestation?nonce=${"a".repeat(64)}`);
    expect(attestationResponse.status).toBe(200);
    expect(await attestationResponse.json()).toMatchObject({
      binding: { nonce: "a".repeat(64) },
      evidence: { platform: "DEV_UNVERIFIED" },
    });

    const replyPublicKey = bytesToBase64Url(boxPublicKeyFromSecret(buyerReplySecret));
    const signed = signTerms({
      terms: privateTerms(),
      role: "BUYER",
      signerId: "buyer.testnet",
      replyKeyId: "buyer-reply-v1",
      replyPublicKey,
      submissionNonce: "buyer_http_submission_0001",
      signingSeed: buyerSeed,
    });
    const envelope = encryptJsonForRecipient({
      payload: signed,
      recipientPublicKey: boxPublicKeyFromSecret(teeSecret),
      recipientKeyId: "tee-key-v1",
      context: TERMS_REQUEST_CONTEXT,
    });
    const response = await fetch(`${baseUrl}/v1/terms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { envelope: Parameters<typeof decryptJsonEnvelope>[0]["envelope"] };
    expect(
      decryptJsonEnvelope<Record<string, unknown>>({
        envelope: body.envelope,
        recipientSecretKey: buyerReplySecret,
        expectedKeyId: "buyer-reply-v1",
        expectedContext: WORKER_RESPONSE_CONTEXT,
      }),
    ).toMatchObject({ ok: true, status: "WAITING_FOR_COUNTERPARTY" });
  });

  it("rejects plaintext terms and unknown routes without echoing private input", async () => {
    const { baseUrl, logs } = await startServer();
    const response = await fetch(`${baseUrl}/v1/terms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terms: privateTerms() }),
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Request envelope is required");
    expect(body).not.toContain("priceAtomic");

    const missing = await fetch(`${baseUrl}/not-a-route`);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(logs)).not.toContain("priceAtomic");
    expect(logs).toHaveLength(2);
  });
});
