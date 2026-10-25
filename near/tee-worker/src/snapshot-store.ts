import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { base64UrlToBytes, bytesToBase64Url } from "@air-otc/shared-types";
import { stableJson, validateState } from "./state.js";
import type { LedgerStateV1, StateStore } from "./types.js";

const SNAPSHOT_AAD = Buffer.from("airotc:encrypted-ledger-snapshot:v1", "utf8");

interface SnapshotEnvelopeV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

export class EncryptedFileStateStore implements StateStore {
  constructor(
    private readonly filePath: string,
    private readonly key: Uint8Array,
  ) {
    if (key.length !== 32) throw new Error("Ledger encryption key must be 32 bytes");
  }

  async load(): Promise<LedgerStateV1 | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(encoded) as SnapshotEnvelopeV1;
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
      throw new Error("Unsupported encrypted snapshot");
    }
    const nonce = base64UrlToBytes(envelope.nonce);
    const ciphertext = base64UrlToBytes(envelope.ciphertext);
    const tag = base64UrlToBytes(envelope.authenticationTag);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted snapshot parameters");
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(SNAPSHOT_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return validateState(JSON.parse(plaintext.toString("utf8")) as LedgerStateV1);
    } finally {
      plaintext.fill(0);
    }
  }

  async save(state: LedgerStateV1): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(SNAPSHOT_AAD);
    const plaintext = Buffer.from(stableJson(state), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const envelope: SnapshotEnvelopeV1 = {
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(ciphertext),
      authenticationTag: bytesToBase64Url(cipher.getAuthTag()),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export class MemoryStateStore implements StateStore {
  private state: LedgerStateV1 | null = null;

  async load(): Promise<LedgerStateV1 | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async save(state: LedgerStateV1): Promise<void> {
    this.state = structuredClone(state);
  }
}

