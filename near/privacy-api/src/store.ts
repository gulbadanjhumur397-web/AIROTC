import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { base64UrlToBytes, bytesToBase64Url } from "@air-otc/shared-types";
import type { ApiStateV1, StateDatabase } from "./types.js";

const AAD = Buffer.from("airotc:privacy-api-database:v1", "utf8");

interface DatabaseEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

export function emptyState(): ApiStateV1 {
  return {
    version: 1,
    revision: "0",
    tokens: {},
    listings: {},
    tickets: {},
    messages: {},
    deliveries: {},
    usedRequests: {},
  };
}

export class EncryptedFileDatabase implements StateDatabase {
  constructor(
    private readonly filePath: string,
    private readonly key: Uint8Array,
  ) {
    if (key.length !== 32) throw new Error("Database encryption key must be 32 bytes");
  }

  async load(): Promise<ApiStateV1 | null> {
    let encoded: string;
    try {
      encoded = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(encoded) as DatabaseEnvelope;
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported encrypted database");
    const nonce = base64UrlToBytes(envelope.nonce);
    const tag = base64UrlToBytes(envelope.authenticationTag);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted database parameters");
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(base64UrlToBytes(envelope.ciphertext)), decipher.final()]);
    try {
      return validateDatabaseState(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  }

  async save(state: ApiStateV1): Promise<void> {
    validateDatabaseState(state);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from(JSON.stringify(state), "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const envelope: DatabaseEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(ciphertext),
      authenticationTag: bytesToBase64Url(cipher.getAuthTag()),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export class MemoryDatabase implements StateDatabase {
  private value: ApiStateV1 | null = null;

  async load(): Promise<ApiStateV1 | null> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async save(state: ApiStateV1): Promise<void> {
    this.value = structuredClone(validateDatabaseState(state));
  }

  snapshot(): ApiStateV1 | null {
    return this.value === null ? null : structuredClone(this.value);
  }
}

export function validateDatabaseState(value: unknown): ApiStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Database state must be an object");
  const state = value as ApiStateV1;
  if (state.version !== 1 || typeof state.revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(state.revision)) {
    throw new Error("Database state version or revision is invalid");
  }
  for (const field of [
    state.tokens,
    state.listings,
    state.tickets,
    state.messages,
    state.deliveries,
    state.usedRequests,
  ]) {
    if (typeof field !== "object" || field === null || Array.isArray(field)) throw new Error("Database collection is invalid");
  }
  return state;
}
