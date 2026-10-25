import { beforeEach, describe, expect, it } from "vitest";
import { boxPublicKeyFromSecret, bytesToBase64Url } from "@air-otc/shared-types";
import { BrowserDealClient } from "../src/privacy-client.js";
import type { SessionMaterial } from "../src/session-vault.js";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", { value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "11111111-2222-4333-8444-555555555555", getRandomValues: (value: Uint8Array) => { value.fill(4); return value; } } });

const session: SessionMaterial = { signingSeed: new Uint8Array(32).fill(2), boxSecretKey: new Uint8Array(32).fill(3), keyId: "browser-box-v1" };
beforeEach(() => memory.clear());

describe("browser privacy boundary", () => {
  it("encrypts product, messages, and delivery before any API request", async () => {
    const bodies: string[] = [];
    const otherPublic = bytesToBase64Url(boxPublicKeyFromSecret(new Uint8Array(32).fill(9)));
    const fetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      const url = String(request);
      if (/\/v1\/tickets\/ticket_/.test(url) && init?.method === "GET") return json(200, { buyerEncryptionKeyId: session.keyId, buyerEncryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(session.boxSecretKey)), sellerEncryptionKeyId: "seller-box-v1", sellerEncryptionPublicKey: otherPublic });
      return json(200, { listingRef: "listing_ok", ticketRef: "ticket_ok", deliveryCommitment: "a".repeat(64) });
    };
    const client = new BrowserDealClient("http://api.test", fetcher as typeof fetch);
    client.setToken("airotc_near_browser_test_token_1234567890");
    await client.createListing(session, "OTHER", { secret: "PRIVATE_PRODUCT_SENTINEL" });
    await client.sendMessage(session, "ticket_1234567890123456789012", "PRIVATE_MESSAGE_SENTINEL");
    await client.storeDelivery(session, "ticket_1234567890123456789012", { secret: "PRIVATE_DELIVERY_SENTINEL" });
    const outbound = bodies.join("\n");
    expect(outbound).not.toContain("PRIVATE_PRODUCT_SENTINEL");
    expect(outbound).not.toContain("PRIVATE_MESSAGE_SENTINEL");
    expect(outbound).not.toContain("PRIVATE_DELIVERY_SENTINEL");
    expect(outbound).toContain("ciphertext");
  });

  it("keeps the bearer token in a header and out of request bodies", async () => {
    let seenHeader = ""; let seenBody = "";
    const client = new BrowserDealClient("http://api.test", (async (_request, init) => { seenHeader = String((init?.headers as Record<string, string>).authorization); seenBody = String(init?.body ?? ""); return json(200, { listings: [] }); }) as typeof fetch);
    client.setToken("airotc_near_browser_test_token_1234567890");
    await client.listings();
    expect(seenHeader).toContain("airotc_near_");
    expect(seenBody).not.toContain("airotc_near_");
  });

  it("fails closed before sending a private worker action without a trust policy", async () => {
    let calls = 0;
    const client = new BrowserDealClient("http://api.test", (async () => {
      calls += 1;
      return json(500, {});
    }) as typeof fetch);
    client.setToken("airotc_near_browser_test_token_1234567890");
    await expect(client.workerAction(session, "buyer.testnet", { type: "GET_BALANCE" }, "pool-read")).rejects.toThrow(/trust policy/);
    expect(calls).toBe(0);
  });
});

function json(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
