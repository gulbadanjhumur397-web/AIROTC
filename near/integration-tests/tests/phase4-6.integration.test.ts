import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex, publicKeyFromSeed, sha256Bytes, utf8, workerEncryptionKeyHash, type FinalTermsV1 } from "@air-otc/shared-types";
import { DevelopmentAttestationProvider } from "../../tee-worker/src/attestation.js";
import { MemoryContractGateway } from "../../tee-worker/src/contract-gateway.js";
import { StaticIdentityVerifier as WorkerIdentityVerifier } from "../../tee-worker/src/identity.js";
import { createWorkerServer } from "../../tee-worker/src/server.js";
import { MemoryStateStore } from "../../tee-worker/src/snapshot-store.js";
import { ConfidentialWorker } from "../../tee-worker/src/worker.js";
import { MemoryDatabase } from "../../privacy-api/src/store.js";
import { createPrivacyApiServer, type AuditEvent } from "../../privacy-api/src/server.js";
import { HttpWorkerProxy, PrivacyApiService } from "../../privacy-api/src/service.js";
import { StaticIdentityVerifier, TokenService, type TokenGrant } from "../../privacy-api/src/token-service.js";
import { PrivacyApiClient } from "../../mcp-server/src/api-client.js";
import { AgentTools } from "../../mcp-server/src/tools.js";
import { WorkerTrustVerifier } from "../../mcp-server/src/worker-trust.js";
import { BrowserDealClient } from "../../web/src/privacy-client.js";
import type { SessionMaterial } from "../../web/src/session-vault.js";

const now = 1_900_000_000_000_000_000n;
const clock = { nowNs: () => now };
const openServers: Array<ReturnType<typeof createWorkerServer> | ReturnType<typeof createPrivacyApiServer>> = [];
const browserStorage = new Map<string, string>();
let uuidCounter = 0;
Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: (key: string) => browserStorage.get(key) ?? null, setItem: (key: string, value: string) => browserStorage.set(key, value), removeItem: (key: string) => browserStorage.delete(key) } });
Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => `12345678-1234-4234-8234-${String(++uuidCounter).padStart(12, "0")}`, getRandomValues: (value: Uint8Array) => { value.fill(5); return value; } } });

afterEach(async () => {
  browserStorage.clear();
  uuidCounter = 0;
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function grant(walletId: string, role: "BUYER" | "SELLER"): TokenGrant {
  return { version: 1, walletId, roles: [role], scopes: ["marketplace:read", "marketplace:write", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write", "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke"], policy: { maxWithdrawalAtomic: "1000", maxCumulativeWithdrawalAtomic: "2000" }, expiresAtNs: (now + 1_000_000_000_000n).toString() };
}

describe("Phase 4-6 browser/MCP/TEE integration", () => {
  it("moves private product, chat, and matching terms through ciphertext-only boundaries", async () => {
    const buyerSeed = new Uint8Array(32).fill(11);
    const sellerSeed = new Uint8Array(32).fill(12);
    const buyerSession: SessionMaterial = { signingSeed: buyerSeed, boxSecretKey: new Uint8Array(32).fill(21), keyId: "buyer-browser-box" };
    const sellerBoxSecret = new Uint8Array(32).fill(22);
    const teeSecret = new Uint8Array(32).fill(31);
    const worker = new ConfidentialWorker({
      workerId: "tee-worker.testnet", encryptionKeyId: "tee-encryption-v1", encryptionSecretKey: teeSecret,
      stateStore: new MemoryStateStore(), contract: new MemoryContractGateway(), clock,
      identityVerifier: new WorkerIdentityVerifier(new Map([
        ["buyer.testnet", new Set([publicKeyFromSeed(buyerSeed)])],
        ["seller.testnet", new Set([publicKeyFromSeed(sellerSeed)])],
      ])),
    });
    await worker.initialize();
    const workerLogs: unknown[] = [];
    const workerServer = createWorkerServer(worker, new DevelopmentAttestationProvider(), (event) => workerLogs.push(event));
    openServers.push(workerServer);
    const workerUrl = await listen(workerServer);

    const database = new MemoryDatabase();
    const tokenService = new TokenService(new StaticIdentityVerifier(new Map()), clock, new Uint8Array(32).fill(44));
    const service = new PrivacyApiService(database, tokenService, new HttpWorkerProxy(workerUrl), clock);
    await service.initialize();
    const buyerToken = await service.issueTokenForTesting(grant("buyer.testnet", "BUYER"));
    const sellerToken = await service.issueTokenForTesting(grant("seller.testnet", "SELLER"));
    const apiLogs: AuditEvent[] = [];
    const apiServer = createPrivacyApiServer(service, { logger: (event) => apiLogs.push(event) });
    openServers.push(apiServer);
    const apiUrl = await listen(apiServer);

    const workerPolicy = async () => ({
      workerId: worker.identity().workerId,
      encryptionKeyHash: workerEncryptionKeyHash(worker.identity()),
      composeHash: "0".repeat(64),
      allowDevelopment: true,
    });
    const sellerApi = new PrivacyApiClient(apiUrl, sellerToken.token);
    const sellerTrust = new WorkerTrustVerifier(sellerApi, workerPolicy);
    const seller = new AgentTools({ api: sellerApi, accountId: "seller.testnet", signingSeed: sellerSeed, boxSecretKey: sellerBoxSecret, boxKeyId: "seller-agent-box", verifiedWorker: () => sellerTrust.verify(), nowNs: () => now });
    const buyer = new BrowserDealClient(apiUrl, fetch, workerPolicy);
    buyer.setToken(buyerToken.token);

    const listing = await seller.call("marketplace_create", { requestId: "integration_listing_create_1", kind: "API_ACCESS", tagHashes: [], product: { title: "Demo API", apiKey: "PRODUCT_SECRET_SENTINEL" } }) as Record<string, string>;
    const listingRef = listing.listingRef;
    if (!listingRef) throw new Error("Listing reference missing");
    const marketplace = await buyer.listings();
    expect(marketplace.listings).toHaveLength(1);
    const ticket = await buyer.createTicket(buyerSession, listingRef);
    await buyer.sendMessage(buyerSession, ticket.ticketRef, "CHAT_SECRET_SENTINEL");
    const sellerMessages = await seller.call("ticket_messages", { ticketRef: ticket.ticketRef }) as { messages: Array<{ payload: { message: string } }> };
    expect(sellerMessages.messages[0]?.payload.message).toBe("CHAT_SECRET_SENTINEL");

    const terms: FinalTermsV1 = {
      version: 1, ticketId: ticket.ticketRef, buyerId: "buyer.testnet", sellerId: "seller.testnet",
      assetDescriptionHash: bytesToHex(sha256Bytes(utf8("TERMS_SECRET_SENTINEL"))), currency: "NEAR_TESTNET",
      priceAtomic: "500", buyerCollateralAtomic: "100", sellerCollateralAtomic: "200",
      fundingDeadlineNs: (now + 1_000_000_000_000n).toString(), deliveryDeadlineNs: (now + 2_000_000_000_000n).toString(), confirmationDeadlineNs: (now + 3_000_000_000_000n).toString(),
      sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL", buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
      nonce: "integration_agreement_nonce_01", expiresAtNs: (now + 500_000_000_000n).toString(),
    };
    const buyerResult = await buyer.submitTerms(buyerSession, "buyer.testnet", "BUYER", terms);
    expect(buyerResult.status).toBe("WAITING_FOR_COUNTERPARTY");
    const sellerResult = await seller.call("terms_submit", { requestId: "integration_terms_submit_01", submissionNonce: "integration_seller_submit_01", role: "SELLER", terms });
    expect(sellerResult).toMatchObject({ ok: true, status: "MATCH_AWAITING_BALANCE" });

    const persisted = JSON.stringify(database.snapshot());
    const logs = JSON.stringify({ apiLogs, workerLogs });
    for (const secret of ["PRODUCT_SECRET_SENTINEL", "CHAT_SECRET_SENTINEL", "TERMS_SECRET_SENTINEL", buyerToken.token, sellerToken.token]) {
      expect(persisted).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});

async function listen(server: ReturnType<typeof createWorkerServer> | ReturnType<typeof createPrivacyApiServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
