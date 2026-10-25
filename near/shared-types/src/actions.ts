import bs58 from "bs58";
import nacl from "tweetnacl";
import { base64UrlToBytes, canonicalObjectJson, utf8 } from "./encoding.js";
import { isSha256Hex } from "./hash.js";
import { requireUnsignedInteger } from "./terms.js";

export const ACTION_VERSION = 1 as const;
export const ACTION_SIGNATURE_DOMAIN = "airotc:worker-action:v1";

export type WorkerAction =
  | { type: "CLAIM_DEPOSIT"; depositSecret: string }
  | { type: "SUBMIT_DELIVERY"; ticketId: string; deliveryCommitment: string }
  | { type: "CONFIRM_DELIVERY"; ticketId: string }
  | { type: "REQUEST_CANCELLATION"; ticketId: string }
  | { type: "PROCESS_TIMEOUT"; ticketId: string }
  | { type: "GET_BALANCE" }
  | { type: "GET_DEAL_STATUS"; ticketId: string }
  | { type: "REQUEST_WITHDRAWAL"; recipientId: string; amountAtomic: string };

export interface SignedWorkerActionV1 {
  version: typeof ACTION_VERSION;
  actorId: string;
  publicKey: string;
  replyKeyId: string;
  replyPublicKey: string;
  nonce: string;
  expiresAtNs: string;
  action: WorkerAction;
  signature: string;
}

type UnsignedWorkerActionV1 = Omit<SignedWorkerActionV1, "signature">;

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !/^[a-z0-9._-]+$/.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

function requireNonce(value: unknown): string {
  if (typeof value !== "string" || value.length < 22 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Action nonce has an invalid format");
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

function requireTicketId(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("ticketId has an invalid format");
  }
  return value;
}

function parsePublicKey(value: string): Uint8Array {
  if (!value.startsWith("ed25519:")) throw new Error("Only ed25519 NEAR public keys are supported");
  const publicKey = bs58.decode(value.slice("ed25519:".length));
  if (publicKey.length !== nacl.sign.publicKeyLength) throw new Error("Invalid ed25519 public key length");
  return publicKey;
}

function normalizeAction(value: unknown): WorkerAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Action must be an object");
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case "CLAIM_DEPOSIT": {
      if (Object.keys(action).sort().join(",") !== "depositSecret,type") throw new Error("Invalid claim-deposit fields");
      if (typeof action.depositSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(action.depositSecret)) {
        throw new Error("depositSecret must encode 32 bytes as base64url");
      }
      return { type: "CLAIM_DEPOSIT", depositSecret: action.depositSecret };
    }
    case "SUBMIT_DELIVERY": {
      if (Object.keys(action).sort().join(",") !== "deliveryCommitment,ticketId,type") {
        throw new Error("Invalid delivery fields");
      }
      if (!isSha256Hex(action.deliveryCommitment)) throw new Error("deliveryCommitment must be a SHA-256 hash");
      return {
        type: "SUBMIT_DELIVERY",
        ticketId: requireTicketId(action.ticketId),
        deliveryCommitment: action.deliveryCommitment,
      };
    }
    case "CONFIRM_DELIVERY":
    case "REQUEST_CANCELLATION":
    case "PROCESS_TIMEOUT":
    case "GET_DEAL_STATUS": {
      if (Object.keys(action).sort().join(",") !== "ticketId,type") throw new Error("Invalid ticket action fields");
      return { type: action.type, ticketId: requireTicketId(action.ticketId) };
    }
    case "GET_BALANCE": {
      if (Object.keys(action).sort().join(",") !== "type") throw new Error("Invalid balance-query fields");
      return { type: "GET_BALANCE" };
    }
    case "REQUEST_WITHDRAWAL": {
      if (Object.keys(action).sort().join(",") !== "amountAtomic,recipientId,type") {
        throw new Error("Invalid withdrawal fields");
      }
      return {
        type: "REQUEST_WITHDRAWAL",
        recipientId: requireIdentity(action.recipientId, "recipientId"),
        amountAtomic: requireUnsignedInteger(action.amountAtomic, "amountAtomic", false),
      };
    }
    default:
      throw new Error("Unsupported worker action");
  }
}

function normalizeUnsigned(value: unknown): UnsignedWorkerActionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Signed action must be an object");
  }
  const object = value as Record<string, unknown>;
  if (object.version !== ACTION_VERSION) throw new Error("Unsupported action version");
  const actorId = requireIdentity(object.actorId, "actorId");
  if (typeof object.publicKey !== "string") throw new Error("publicKey must be a string");
  parsePublicKey(object.publicKey);
  const reply = requireReplyKey(object.replyKeyId, object.replyPublicKey);
  const nonce = requireNonce(object.nonce);
  const expiresAtNs = requireUnsignedInteger(object.expiresAtNs, "expiresAtNs", false);
  const action = normalizeAction(object.action);
  return {
    version: ACTION_VERSION,
    actorId,
    publicKey: object.publicKey,
    ...reply,
    nonce,
    expiresAtNs,
    action,
  };
}

export function workerActionSignaturePayload(value: UnsignedWorkerActionV1): Uint8Array {
  const normalized = normalizeUnsigned(value);
  return utf8(`${ACTION_SIGNATURE_DOMAIN}\0${canonicalObjectJson(normalized as unknown as Record<string, unknown>)}`);
}

export function signWorkerAction(input: {
  actorId: string;
  publicKey: string;
  replyKeyId: string;
  replyPublicKey: string;
  nonce: string;
  expiresAtNs: string;
  action: WorkerAction;
  signingSeed: Uint8Array;
}): SignedWorkerActionV1 {
  if (input.signingSeed.length !== nacl.sign.seedLength) throw new Error("Signing seed must be 32 bytes");
  const unsigned = normalizeUnsigned({
    version: ACTION_VERSION,
    actorId: input.actorId,
    publicKey: input.publicKey,
    replyKeyId: input.replyKeyId,
    replyPublicKey: input.replyPublicKey,
    nonce: input.nonce,
    expiresAtNs: input.expiresAtNs,
    action: input.action,
  });
  const pair = nacl.sign.keyPair.fromSeed(input.signingSeed);
  const derivedPublicKey = `ed25519:${bs58.encode(pair.publicKey)}`;
  if (derivedPublicKey !== unsigned.publicKey) throw new Error("publicKey does not match signing seed");
  return {
    ...unsigned,
    signature: bs58.encode(nacl.sign.detached(workerActionSignaturePayload(unsigned), pair.secretKey)),
  };
}

export function verifySignedWorkerAction(value: unknown): SignedWorkerActionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Signed action must be an object");
  const object = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    "actorId",
    "publicKey",
    "replyKeyId",
    "replyPublicKey",
    "nonce",
    "expiresAtNs",
    "action",
    "signature",
  ].sort();
  const actualKeys = Object.keys(object).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Signed action contains missing or unsupported fields");
  }
  const unsigned = normalizeUnsigned(object);
  if (typeof object.signature !== "string") throw new Error("signature must be a string");
  const signature = bs58.decode(object.signature);
  if (signature.length !== nacl.sign.signatureLength) throw new Error("Invalid signature length");
  if (!nacl.sign.detached.verify(workerActionSignaturePayload(unsigned), signature, parsePublicKey(unsigned.publicKey))) {
    throw new Error("Invalid action signature");
  }
  return { ...unsigned, signature: object.signature };
}

