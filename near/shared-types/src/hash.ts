import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8 } from "./encoding.js";

export function sha256Bytes(...parts: Uint8Array[]): Uint8Array {
  return sha256(concatBytes(...parts));
}

export function domainSeparatedHash(domain: string, payload: Uint8Array): string {
  return bytesToHex(sha256Bytes(utf8(`${domain}\0`), payload));
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

