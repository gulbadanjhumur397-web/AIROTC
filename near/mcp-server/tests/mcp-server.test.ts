import { describe, expect, it } from "vitest";
import { boxPublicKeyFromSecret, bytesToBase64Url, encryptJsonForRecipient } from "@air-otc/shared-types";
import { PrivacyApiClient } from "../src/api-client.js";
import { assertNoPrivateKeys, McpStdioServer } from "../src/server.js";
import { AgentTools } from "../src/tools.js";

const teeSecret = new Uint8Array(32).fill(6);
const boxSecret = new Uint8Array(32).fill(7);
const signingSeed = new Uint8Array(32).fill(8);
const teePublic = bytesToBase64Url(boxPublicKeyFromSecret(teeSecret));
const boxPublic = bytesToBase64Url(boxPublicKeyFromSecret(boxSecret));

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function tools(fetcher: typeof fetch) {
  return new AgentTools({
    api: new PrivacyApiClient("http://api.test", "airotc_near_test_token_12345678901234567890", fetcher),
    accountId: "buyer.testnet",
    signingSeed,
    boxSecretKey: boxSecret,
    boxKeyId: "buyer-box-v1",
    verifiedWorker: async () => ({
      identity: { workerId: "tee-worker.testnet", encryptionKeyId: "tee-box-v1", encryptionPublicKey: teePublic },
      platform: "DSTACK_CVM",
      reportData: "a".repeat(64),
      composeHash: "b".repeat(64),
    }),
    nowNs: () => 1_900_000_000_000_000_000n,
  });
}

const terms = {
  version: 1,
  ticketId: "ticket_01JHACKATHON0001",
  buyerId: "buyer.testnet",
  sellerId: "seller.testnet",
  assetDescriptionHash: "a".repeat(64),
  currency: "NEAR_TESTNET",
  priceAtomic: "500",
  buyerCollateralAtomic: "100",
  sellerCollateralAtomic: "200",
  fundingDeadlineNs: "1900001000000000000",
  deliveryDeadlineNs: "1900002000000000000",
  confirmationDeadlineNs: "1900003000000000000",
  sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
  buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
  nonce: "agreement_nonce_mcp_000001",
  expiresAtNs: "1900000500000000000",
};

const highImpactCases: Array<[string, Record<string, unknown>]> = [
  ["marketplace_create", { requestId: "request_marketplace_create", kind: "OTHER", tagHashes: [], product: { title: "private" } }],
  ["ticket_create", { requestId: "request_ticket_create_001", listingRef: "listing_1234567890123456789012" }],
  ["ticket_send_message", { requestId: "request_ticket_message_01", ticketRef: "ticket_12345678901234567890123", message: "private" }],
  ["terms_submit", { requestId: "request_terms_submit_0001", submissionNonce: "submission_nonce_mcp_000001", role: "BUYER", terms }],
  ["pool_claim_deposit", { requestId: "request_claim_deposit_001", actionNonce: "action_nonce_claim_000001", depositSecret: "A".repeat(43) }],
  ["delivery_store", { requestId: "request_delivery_store_001", ticketRef: "ticket_12345678901234567890123", delivery: { key: "private" } }],
  ["delivery_submit", { requestId: "request_delivery_submit_01", actionNonce: "action_nonce_delivery_0001", ticketId: "ticket_12345678901234567890123", deliveryCommitment: "b".repeat(64) }],
  ["delivery_confirm", { requestId: "request_delivery_confirm_1", actionNonce: "action_nonce_confirm_00001", ticketId: "ticket_12345678901234567890123" }],
  ["deal_cancel", { requestId: "request_deal_cancel_00001", actionNonce: "action_nonce_cancel_000001", ticketId: "ticket_12345678901234567890123" }],
  ["deal_timeout", { requestId: "request_deal_timeout_0001", actionNonce: "action_nonce_timeout_00001", ticketId: "ticket_12345678901234567890123" }],
  ["withdrawal_request", { requestId: "request_withdrawal_000001", actionNonce: "action_nonce_withdraw_0001", amountAtomic: "500" }],
  ["token_rotate", { requestId: "request_token_rotate_0001" }],
  ["token_revoke", { requestId: "request_token_revoke_0001" }],
];

function preliminary(url: string): Response | null {
  if (/\/v1\/tickets\/ticket_/.test(url)) return response(200, {
    buyerEncryptionKeyId: "buyer-box-v1", buyerEncryptionPublicKey: boxPublic,
    sellerEncryptionKeyId: "seller-box-v1", sellerEncryptionPublicKey: teePublic,
  });
  return null;
}

describe("MCP tool surface", () => {
  it("exposes the complete Phase 5 tool set and MCP JSON-RPC discovery", async () => {
    const agent = tools(async () => response(200, {}) as never);
    expect(agent.list().map((tool) => tool.name)).toEqual([
      "marketplace_list", "marketplace_create", "ticket_create", "ticket_list", "ticket_get", "ticket_messages",
      "ticket_send_message", "terms_submit", "pool_identity", "pool_attestation", "pool_claim_deposit", "pool_get_balance",
      "delivery_store", "delivery_get", "delivery_submit", "delivery_confirm", "deal_status", "deal_cancel", "deal_timeout",
      "withdrawal_request", "token_rotate", "token_revoke",
    ]);
    const server = new McpStdioServer(agent);
    const initialized = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initialized).toMatchObject({ result: { serverInfo: { name: "air-otc-near" } } });
    const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((listed?.result as { tools: unknown[] }).tools).toHaveLength(22);
  });

  it.each(highImpactCases)("propagates authorization denial for %s without leaking credentials", async (name, input) => {
    const agent = tools(async () => response(401, { error: { code: "UNAUTHORIZED", message: "Invalid or revoked MCP token" } }) as never);
    await expect(agent.call(name, input)).rejects.toThrow("UNAUTHORIZED");
  });

  it.each(highImpactCases)("propagates replay denial for %s", async (name, input) => {
    const agent = tools(async (request, init) => {
      const url = String(request);
      return ((init?.method === "GET" ? preliminary(url) : null) ?? response(409, { error: { code: "REQUEST_REPLAY", message: "Request ID was already used" } })) as never;
    });
    await expect(agent.call(name, input)).rejects.toThrow("REQUEST_REPLAY");
  });

  it("encrypts private listing fields before the API boundary", async () => {
    let body = "";
    const agent = tools(async (_request, init) => { body = String(init?.body ?? ""); return response(201, { listingRef: "listing_ok" }) as never; });
    await agent.call("marketplace_create", { requestId: "request_listing_cipher_001", kind: "API_ACCESS", tagHashes: [], product: { apiKey: "PLAINTEXT_SENTINEL" } });
    expect(body).not.toContain("PLAINTEXT_SENTINEL");
    expect(body).toContain("encryptedProduct");
  });

  it("decrypts worker responses locally and never exposes key material", async () => {
    const encrypted = encryptJsonForRecipient({ payload: { status: "OK" }, recipientPublicKey: boxPublicKeyFromSecret(boxSecret), recipientKeyId: "buyer-box-v1", context: "airotc:worker-response:v1" });
    const agent = tools(async () => response(200, { envelope: encrypted }) as never);
    const result = await agent.call("pool_get_balance", { requestId: "request_balance_query_0001", actionNonce: "action_nonce_balance_00001" });
    expect(result).toEqual({ status: "OK" });
    expect(() => assertNoPrivateKeys(result)).not.toThrow();
    expect(() => assertNoPrivateKeys({ privateKey: "leak" })).toThrow("forbidden");
  });

  it("rotates a token internally without returning the replacement token to the model", async () => {
    const agent = tools(async () => response(201, { token: "airotc_near_rotated_12345678901234567890", expiresAtNs: "2", scopes: [], roles: [] }) as never);
    const result = await agent.call("token_rotate", { requestId: "request_rotate_internal_001" });
    expect(JSON.stringify(result)).not.toContain("airotc_near_");
    expect(result).toMatchObject({ rotated: true });
  });

  it("fails closed before encrypting terms when the worker trust check fails", async () => {
    let apiCalls = 0;
    const agent = new AgentTools({
      api: new PrivacyApiClient("http://api.test", "airotc_near_test_token_12345678901234567890", (async () => {
        apiCalls += 1;
        return response(500, {});
      }) as typeof fetch),
      accountId: "buyer.testnet",
      signingSeed,
      boxSecretKey: boxSecret,
      boxKeyId: "buyer-box-v1",
      verifiedWorker: async () => { throw new Error("Worker encryption identity is not approved"); },
      nowNs: () => 1_900_000_000_000_000_000n,
    });
    await expect(agent.call("terms_submit", {
      requestId: "request_terms_trust_gate_1",
      submissionNonce: "submission_nonce_trust_0001",
      role: "BUYER",
      terms,
    })).rejects.toThrow(/not approved/);
    expect(apiCalls).toBe(0);
  });
});
