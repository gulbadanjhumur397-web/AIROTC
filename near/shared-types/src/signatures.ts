import bs58 from "bs58";
import nacl from "tweetnacl";
import { base64UrlToBytes, canonicalObjectJson, utf8 } from "./encoding.js";
import { normalizeTerms, hashTerms, type FinalTermsV1 } from "./terms.js";

export const SIGNATURE_VERSION = 1 as const;
export const SIGNATURE_DOMAIN = "airotc:terms-signature:v1";
export type PartyRole = "BUYER" | "SELLER";

export interface SignedTermsV1 {
  version: typeof SIGNATURE_VERSION;
  role: PartyRole;
  signerId: string;
  publicKey: string;
  replyKeyId: string;
  replyPublicKey: string;
  submissionNonce: string;
  termsHash: string;
  terms: FinalTermsV1;
  signature: string;
}

export interface UnsignedTermsSignatureV1 {
  version: typeof SIGNATURE_VERSION;
  role: PartyRole;
  signerId: string;
  publicKey: string;
  replyKeyId: string;
  replyPublicKey: string;
  submissionNonce: string;
  termsHash: string;
}

function parseNearPublicKey(value: string): Uint8Array {
  if (!value.startsWith("ed25519:")) throw new Error("Only ed25519 NEAR public keys are supported");
  const decoded = bs58.decode(value.slice("ed25519:".length));
  if (decoded.length !== nacl.sign.publicKeyLength) throw new Error("Invalid ed25519 public key length");
  return decoded;
}

function normalizeRole(value: unknown): PartyRole {
  if (value !== "BUYER" && value !== "SELLER") throw new Error("Invalid party role");
  return value;
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !/^[a-z0-9._-]+$/.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function requireNonce(value: unknown): string {
  if (typeof value !== "string" || value.length < 22 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("submissionNonce has an invalid format");
  }
  return value;
}

function requireReplyKey(keyId: unknown, publicKey: unknown): { replyKeyId: string; replyPublicKey: string } {
  if (typeof keyId !== "string" || keyId.length < 3 || keyId.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(keyId)) {
    throw new Error("replyKeyId has an invalid format");
  }
  if (typeof publicKey !== "string" || base64UrlToBytes(publicKey).length !== nacl.box.publicKeyLength) {
    throw new Error("replyPublicKey must encode a 32-byte X25519 public key");
  }
  return { replyKeyId: keyId, replyPublicKey: publicKey };
}

export function signaturePayload(input: UnsignedTermsSignatureV1): Uint8Array {
  return utf8(`${SIGNATURE_DOMAIN}\0${canonicalObjectJson(input as unknown as Record<string, unknown>)}`);
}

export function publicKeyFromSeed(seed: Uint8Array): string {
  if (seed.length !== nacl.sign.seedLength) throw new Error("Signing seed must be 32 bytes");
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return `ed25519:${bs58.encode(pair.publicKey)}`;
}

export function signTerms(input: {
  terms: unknown;
  role: PartyRole;
  signerId: string;
  replyKeyId: string;
  replyPublicKey: string;
  submissionNonce: string;
  signingSeed: Uint8Array;
}): SignedTermsV1 {
  const terms = normalizeTerms(input.terms);
  const role = normalizeRole(input.role);
  const signerId = requireIdentity(input.signerId, "signerId");
  const expectedSigner = role === "BUYER" ? terms.buyerId : terms.sellerId;
  if (signerId !== expectedSigner) throw new Error("Signer identity does not match the selected role");
  const submissionNonce = requireNonce(input.submissionNonce);
  const reply = requireReplyKey(input.replyKeyId, input.replyPublicKey);
  if (input.signingSeed.length !== nacl.sign.seedLength) throw new Error("Signing seed must be 32 bytes");
  const pair = nacl.sign.keyPair.fromSeed(input.signingSeed);
  const publicKey = `ed25519:${bs58.encode(pair.publicKey)}`;
  const unsigned: UnsignedTermsSignatureV1 = {
    version: SIGNATURE_VERSION,
    role,
    signerId,
    publicKey,
    ...reply,
    submissionNonce,
    termsHash: hashTerms(terms),
  };
  const signature = bs58.encode(nacl.sign.detached(signaturePayload(unsigned), pair.secretKey));
  return { ...unsigned, terms, signature };
}

export function normalizeSignedTerms(value: unknown): SignedTermsV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Signed terms must be an object");
  const object = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    "role",
    "signerId",
    "publicKey",
    "replyKeyId",
    "replyPublicKey",
    "submissionNonce",
    "termsHash",
    "terms",
    "signature",
  ].sort();
  const actualKeys = Object.keys(object).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Signed terms contain missing or unsupported fields");
  }
  if (object.version !== SIGNATURE_VERSION) throw new Error("Unsupported signature version");
  const role = normalizeRole(object.role);
  const signerId = requireIdentity(object.signerId, "signerId");
  if (typeof object.publicKey !== "string") throw new Error("publicKey must be a string");
  parseNearPublicKey(object.publicKey);
  const reply = requireReplyKey(object.replyKeyId, object.replyPublicKey);
  const submissionNonce = requireNonce(object.submissionNonce);
  const terms = normalizeTerms(object.terms);
  const expectedSigner = role === "BUYER" ? terms.buyerId : terms.sellerId;
  if (signerId !== expectedSigner) throw new Error("Signer identity does not match the selected role");
  const termsHash = hashTerms(terms);
  if (object.termsHash !== termsHash) throw new Error("termsHash does not match terms");
  if (typeof object.signature !== "string") throw new Error("signature must be a string");
  const signature = bs58.decode(object.signature);
  if (signature.length !== nacl.sign.signatureLength) throw new Error("Invalid signature length");
  return {
    version: SIGNATURE_VERSION,
    role,
    signerId,
    publicKey: object.publicKey,
    ...reply,
    submissionNonce,
    termsHash,
    terms,
    signature: object.signature,
  };
}

export function verifySignedTerms(value: unknown): SignedTermsV1 {
  const signed = normalizeSignedTerms(value);
  const unsigned: UnsignedTermsSignatureV1 = {
    version: signed.version,
    role: signed.role,
    signerId: signed.signerId,
    publicKey: signed.publicKey,
    replyKeyId: signed.replyKeyId,
    replyPublicKey: signed.replyPublicKey,
    submissionNonce: signed.submissionNonce,
    termsHash: signed.termsHash,
  };
  const signature = bs58.decode(signed.signature);
  if (!nacl.sign.detached.verify(signaturePayload(unsigned), signature, parseNearPublicKey(signed.publicKey))) {
    throw new Error("Invalid terms signature");
  }
  return signed;
}

