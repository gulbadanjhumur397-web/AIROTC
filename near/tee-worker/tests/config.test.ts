import { bytesToBase64Url } from "@air-otc/shared-types";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    TEE_NEAR_ACCOUNT_ID: "worker.testnet",
    TEE_ENCRYPTION_KEY_ID: "worker-key-v1",
    TEE_BOX_SECRET_KEY_B64URL: bytesToBase64Url(new Uint8Array(32).fill(1)),
    TEE_LEDGER_KEY_B64URL: bytesToBase64Url(new Uint8Array(32).fill(2)),
    TEE_NEAR_PRIVATE_KEY: "ed25519:test-only-placeholder",
    NEAR_POOL_CONTRACT_ID: "pool.testnet",
  };
}

describe("worker configuration", () => {
  it("requires verified dstack attestation in production", () => {
    const config = loadConfig(environment());
    expect(config.developmentAttestation).toBe(false);
    expect(config.dstackSocketPath).toBe("/var/run/dstack.sock");
    expect(config.maintenanceIntervalMs).toBe(15_000);

    expect(() =>
      loadConfig({ ...environment(), ALLOW_UNVERIFIED_DEV_ATTESTATION: "true" }),
    ).toThrow(/forbidden in production/);
  });

  it("allows explicitly unverified attestation only for local development", () => {
    const config = loadConfig({
      ...environment(),
      NODE_ENV: "development",
      ALLOW_UNVERIFIED_DEV_ATTESTATION: "true",
    });
    expect(config.developmentAttestation).toBe(true);
    expect(config.dstackSocketPath).toBeNull();
  });

  it("bounds the private-ledger maintenance interval", () => {
    expect(loadConfig({ ...environment(), TEE_MAINTENANCE_INTERVAL_MS: "1000" }).maintenanceIntervalMs).toBe(1_000);
    expect(() => loadConfig({ ...environment(), TEE_MAINTENANCE_INTERVAL_MS: "999" })).toThrow(
      /TEE_MAINTENANCE_INTERVAL_MS/,
    );
    expect(() => loadConfig({ ...environment(), TEE_MAINTENANCE_INTERVAL_MS: "invalid" })).toThrow(
      /TEE_MAINTENANCE_INTERVAL_MS/,
    );
  });
});
