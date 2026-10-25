import { describe, expect, it } from "vitest";
import { assertRestrictedWorkerAccessKey } from "../src/contract-gateway.js";

function provider(permission: unknown, publicKeys = ["ed25519:public"]) {
  return {
    async viewAccessKey() {
      return { permission };
    },
    async viewAccessKeyList() {
      return { keys: publicKeys.map((public_key) => ({ public_key })) };
    },
  };
}

describe("TEE worker NEAR access key", () => {
  it("accepts only the exact pool function-call scope", async () => {
    await expect(
      assertRestrictedWorkerAccessKey(
        provider({
          FunctionCall: {
            receiver_id: "pool.testnet",
            method_names: ["withdraw", "anchor_ledger_root"],
          },
        }),
        "worker.testnet",
        "ed25519:public",
        "pool.testnet",
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a full-access key", "FullAccess"],
    [
      "a key for another receiver",
      { FunctionCall: { receiver_id: "other.testnet", method_names: ["anchor_ledger_root", "withdraw"] } },
    ],
    ["an unrestricted method list", { FunctionCall: { receiver_id: "pool.testnet", method_names: [] } }],
    [
      "an extra contract method",
      { FunctionCall: { receiver_id: "pool.testnet", method_names: ["anchor_ledger_root", "withdraw", "set_paused"] } },
    ],
    ["a missing required method", { FunctionCall: { receiver_id: "pool.testnet", method_names: ["withdraw"] } }],
  ])("rejects %s", async (_label, permission) => {
    await expect(
      assertRestrictedWorkerAccessKey(
        provider(permission),
        "worker.testnet",
        "ed25519:public",
        "pool.testnet",
      ),
    ).rejects.toThrow(/TEE worker key/);
  });

  it.each([
    ["a second account key", ["ed25519:public", "ed25519:other"]],
    ["a different sole key", ["ed25519:other"]],
    ["no account key", []],
  ])("rejects %s", async (_label, publicKeys) => {
    await expect(
      assertRestrictedWorkerAccessKey(
        provider(
          { FunctionCall: { receiver_id: "pool.testnet", method_names: ["anchor_ledger_root", "withdraw"] } },
          publicKeys,
        ),
        "worker.testnet",
        "ed25519:public",
        "pool.testnet",
      ),
    ).rejects.toThrow(/only the provisioned restricted key/);
  });
});
