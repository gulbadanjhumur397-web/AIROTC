import { describe, expect, it, vi } from "vitest";
import { DstackAttestationProvider, attestationReportData } from "../src/attestation.js";

const identity = {
  workerId: "tee-worker.testnet",
  encryptionKeyId: "tee-key-v1",
  encryptionPublicKey: "Pry2khSTRNxU5YFgz5C-2e6h3RToHI6R3lV699ev2RU",
};

describe("dstack attestation adapter", () => {
  it("binds a caller nonce and the worker encryption identity into report_data", () => {
    const first = attestationReportData(identity, "a".repeat(64));
    const second = attestationReportData(identity, "b".repeat(64));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(attestationReportData({ ...identity, encryptionKeyId: "tee-key-v2" }, "a".repeat(64))).not.toBe(first);
  });

  it("requests current info and attestation evidence from the official dstack client", async () => {
    const reportData = attestationReportData(identity, "c".repeat(64));
    const info = vi.fn(async () => ({
          app_id: "11".repeat(20),
          instance_id: "22".repeat(20),
          compose_hash: "33".repeat(32),
          os_image_hash: "44".repeat(32),
    }));
    const attest = vi.fn(async () => ({ attestation: "55".repeat(128) }));
    const provider = new DstackAttestationProvider("/unused-in-test", { info, attest });
    await expect(provider.getEvidence(reportData)).resolves.toMatchObject({
      platform: "DSTACK_CVM",
      reportData,
      composeHash: "33".repeat(32),
      osImageHash: "44".repeat(32),
      attestationHex: "55".repeat(128),
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith(Buffer.from(reportData, "hex"));
  });

  it("rejects malformed platform identity fields", async () => {
    const provider = new DstackAttestationProvider("/unused-in-test", {
      info: async () => ({
        app_id: "invalid",
        instance_id: "22",
        compose_hash: "33".repeat(32),
        os_image_hash: "44".repeat(32),
      }),
      attest: async () => ({ attestation: "55" }),
    });
    await expect(provider.getEvidence("a".repeat(64))).rejects.toThrow(/app_id/);
  });
});
