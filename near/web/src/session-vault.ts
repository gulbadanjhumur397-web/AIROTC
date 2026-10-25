import {
  base64UrlToBytes,
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  createDepositCommitment,
  decryptJsonEnvelope,
  encryptJsonForRecipient,
  publicKeyFromSeed,
  signTerms,
  signWorkerAction,
  type EncryptedEnvelopeV1,
  type FinalTermsV1,
  type PartyRole,
  type WorkerAction,
} from "@air-otc/shared-types";

export interface SessionMaterial { signingSeed: Uint8Array; boxSecretKey: Uint8Array; keyId: string }
let activeSession: { accountId: string; material: SessionMaterial } | null = null;

export function loadOrCreateSession(accountId: string): SessionMaterial {
  if (activeSession?.accountId === accountId) return activeSession.material;
  clearSession();
  const signingSeed = random(32);
  const boxSecretKey = random(32);
  const keyId = `browser-${crypto.randomUUID()}`;
  const material = { signingSeed, boxSecretKey, keyId };
  activeSession = { accountId, material };
  return material;
}

export function clearSession(): void {
  activeSession?.material.signingSeed.fill(0);
  activeSession?.material.boxSecretKey.fill(0);
  activeSession = null;
}
export function sessionPublicKey(session: SessionMaterial): string { return publicKeyFromSeed(session.signingSeed); }
export function sessionBoxPublicKey(session: SessionMaterial): string { return bytesToBase64Url(boxPublicKeyFromSecret(session.boxSecretKey)); }
export function newDepositSecret(): { secret: string; commitment: string } { const secret = bytesToBase64Url(random(32)); return { secret, commitment: createDepositCommitment(secret) }; }

export function encryptFor(payload: unknown, recipientPublicKey: string, recipientKeyId: string, context: string): EncryptedEnvelopeV1 {
  return encryptJsonForRecipient({ payload, recipientPublicKey: base64UrlToBytes(recipientPublicKey), recipientKeyId, context });
}

export function decryptFor<T>(session: SessionMaterial, envelope: EncryptedEnvelopeV1): T {
  return decryptJsonEnvelope<T>({ envelope, recipientSecretKey: session.boxSecretKey, expectedKeyId: session.keyId, expectedContext: envelope.context });
}

export function signedTerms(session: SessionMaterial, accountId: string, role: PartyRole, terms: FinalTermsV1) {
  return signTerms({ terms, role, signerId: accountId, replyKeyId: session.keyId, replyPublicKey: sessionBoxPublicKey(session), submissionNonce: nonce(), signingSeed: session.signingSeed });
}

export function signedAction(session: SessionMaterial, accountId: string, action: WorkerAction) {
  return signWorkerAction({ actorId: accountId, publicKey: sessionPublicKey(session), replyKeyId: session.keyId, replyPublicKey: sessionBoxPublicKey(session), nonce: nonce(), expiresAtNs: (BigInt(Date.now()) * 1_000_000n + 300_000_000_000n).toString(), action, signingSeed: session.signingSeed });
}

export function requestId(): string { return crypto.randomUUID().replaceAll("-", "_"); }
function nonce(): string { return bytesToBase64Url(random(18)); }
function random(length: number): Uint8Array { const value = new Uint8Array(length); crypto.getRandomValues(value); return value; }
