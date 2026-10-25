import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedFileStateStore } from "../src/snapshot-store.js";
import { createEmptyState } from "../src/state.js";

describe("encrypted ledger snapshots", () => {
  it("round-trips without plaintext and rejects tampering", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "airotc-ledger-"));
    const file = path.join(directory, "ledger.snapshot");
    const store = new EncryptedFileStateStore(file, new Uint8Array(32).fill(17));
    const state = createEmptyState();
    state.accounts["private-user.testnet"] = { availableAtomic: "123456789", lockedAtomic: "0" };
    try {
      await store.save(state);
      const encoded = await readFile(file, "utf8");
      expect(encoded).not.toContain("private-user.testnet");
      expect(encoded).not.toContain("123456789");
      expect(await store.load()).toEqual(state);

      const parsed = JSON.parse(encoded) as { ciphertext: string };
      const ciphertext = Buffer.from(parsed.ciphertext, "base64");
      ciphertext[0] ^= 1;
      parsed.ciphertext = ciphertext.toString("base64");
      await writeFile(file, JSON.stringify(parsed));
      await expect(store.load()).rejects.toThrow();

      state.accounts["private-user.testnet"]!.lockedAtomic = "1";
      await store.save(state);
      await expect(store.load()).rejects.toThrow(/unexplained locked balance/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

