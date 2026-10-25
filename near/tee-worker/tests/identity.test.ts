import { describe, expect, it } from "vitest";
import { NearRpcIdentityVerifier } from "../src/identity.js";

function response(permission: unknown): Response {
  return new Response(JSON.stringify({ result: { permission } }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("NEAR account-key isolation", () => {
  it("accepts full-access keys and keys scoped to the configured pool", async () => {
    const full = new NearRpcIdentityVerifier("http://rpc.test", "pool.testnet", (async () => response("FullAccess")) as typeof fetch);
    const scoped = new NearRpcIdentityVerifier("http://rpc.test", "pool.testnet", (async () => response({ FunctionCall: { receiver_id: "pool.testnet", method_names: [] } })) as typeof fetch);
    expect(await full.isAuthorizedKey("buyer.testnet", "ed25519:key")).toBe(true);
    expect(await scoped.isAuthorizedKey("buyer.testnet", "ed25519:key")).toBe(true);
  });

  it("rejects a valid account key scoped to another application", async () => {
    const verifier = new NearRpcIdentityVerifier("http://rpc.test", "pool.testnet", (async () => response({ FunctionCall: { receiver_id: "malicious-app.testnet", method_names: [] } })) as typeof fetch);
    expect(await verifier.isAuthorizedKey("buyer.testnet", "ed25519:key")).toBe(false);
  });
});
