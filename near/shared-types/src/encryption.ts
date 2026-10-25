import nacl from "tweetnacl";
import {
  assertByteLength,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalObjectJson,
  decodeUtf8,
  utf8,
} from "./encoding.js";

export const ENCRYPTION_VERSION = 1 as const;
export const ENCRYPTION_ALGORITHM = "x25519-xsalsa20-poly1305" as const;

export interface EncryptedEnvelopeV1 {
  version: typeof ENCRYPTION_VERSION;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  recipientKeyId: string;
  context: string;
  ephemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
}

interface SealedPayload<T> {
  version: typeof ENCRYPTION_VERSION;
  recipientKeyId: string;
  context: string;
  payload: T;
}

function requireLabel(value: string, field: string): void {
  if (value.length < 3 || value.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
}

export function boxPublicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  assertByteLength(secretKey, nacl.box.secretKeyLength, "Box secret key");
  return nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
}

export function generateBoxKeyPair(randomBytes: (length: number) => Uint8Array = (length) => nacl.randomBytes(length)): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const secretKey = randomBytes(nacl.box.secretKeyLength);
  assertByteLength(secretKey, nacl.box.secretKeyLength, "Generated box secret key");
  const pair = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function encryptJsonForRecipient<T>(input: {
  payload: T;
  recipientPublicKey: Uint8Array;
  recipientKeyId: string;
  context: string;
  randomBytes?: (length: number) => Uint8Array;
}): EncryptedEnvelopeV1 {
  assertByteLength(input.recipientPublicKey, nacl.box.publicKeyLength, "Recipient public key");
  requireLabel(input.recipientKeyId, "recipientKeyId");
  requireLabel(input.context, "context");
  const randomBytes = input.randomBytes ?? ((length: number) => nacl.randomBytes(length));
  const ephemeralSecretKey = randomBytes(nacl.box.secretKeyLength);
  const nonce = randomBytes(nacl.box.nonceLength);
  assertByteLength(ephemeralSecretKey, nacl.box.secretKeyLength, "Ephemeral secret key");
  assertByteLength(nonce, nacl.box.nonceLength, "Box nonce");
  const ephemeralPair = nacl.box.keyPair.fromSecretKey(ephemeralSecretKey);
  const inner: SealedPayload<T> = {
    version: ENCRYPTION_VERSION,
    recipientKeyId: input.recipientKeyId,
    context: input.context,
    payload: input.payload,
  };
  const plaintext = utf8(canonicalObjectJson(inner as unknown as Record<string, unknown>));
  let ciphertext: Uint8Array;
  try {
    ciphertext = nacl.box(plaintext, nonce, input.recipientPublicKey, ephemeralPair.secretKey);
  } finally {
    plaintext.fill(0);
    ephemeralPair.secretKey.fill(0);
    ephemeralSecretKey.fill(0);
  }
  return {
    version: ENCRYPTION_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    recipientKeyId: input.recipientKeyId,
    context: input.context,
    ephemeralPublicKey: bytesToBase64Url(ephemeralPair.publicKey),
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export function decryptJsonEnvelope<T>(input: {
  envelope: EncryptedEnvelopeV1;
  recipientSecretKey: Uint8Array;
  expectedKeyId: string;
  expectedContext: string;
}): T {
  const envelope = input.envelope;
  if (envelope.version !== ENCRYPTION_VERSION || envelope.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new Error("Unsupported encrypted envelope");
  }
  if (envelope.recipientKeyId !== input.expectedKeyId || envelope.context !== input.expectedContext) {
    throw new Error("Encrypted envelope context mismatch");
  }
  assertByteLength(input.recipientSecretKey, nacl.box.secretKeyLength, "Recipient secret key");
  const ephemeralPublicKey = base64UrlToBytes(envelope.ephemeralPublicKey);
  const nonce = base64UrlToBytes(envelope.nonce);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  assertByteLength(ephemeralPublicKey, nacl.box.publicKeyLength, "Ephemeral public key");
  assertByteLength(nonce, nacl.box.nonceLength, "Box nonce");
  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, input.recipientSecretKey);
  if (plaintext === null) throw new Error("Encrypted envelope authentication failed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(plaintext));
  } catch {
    throw new Error("Encrypted envelope plaintext is invalid");
  } finally {
    plaintext.fill(0);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Encrypted envelope plaintext must be an object");
  }
  const sealed = parsed as Record<string, unknown>;
  if (
    sealed.version !== ENCRYPTION_VERSION ||
    sealed.recipientKeyId !== input.expectedKeyId ||
    sealed.context !== input.expectedContext ||
    !("payload" in sealed)
  ) {
    throw new Error("Encrypted envelope inner context mismatch");
  }
  return sealed.payload as T;
}

