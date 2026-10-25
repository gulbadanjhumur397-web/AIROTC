import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  base64UrlToBytes,
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  canonicalizeTerms,
  createDepositCommitment,
  decryptJsonEnvelope,
  encryptJsonForRecipient,
  fetchNearPoolWorkerPolicy,
  hashTerms,
  publicKeyFromSeed,
  signWorkerAction,
  signTerms,
  verifySignedWorkerAction,
  verifySignedTerms,
  verifyWorkerAttestationBinding,
  workerAttestationReportData,
  workerEncryptionKeyHash,
  type FinalTermsV1,
} from "../src/index.js";

const terms: FinalTermsV1 = {
  version: 1,
  ticketId: "ticket_01JTESTVECTOR000001",
  buyerId: "buyer.testnet",
  sellerId: "seller.testnet",
  assetDescriptionHash: "61aaf7411dc22392b475ac0f71a59c5ca6c2e3595b2e7741413f78f3912d2df1",
  currency: "NEAR_TESTNET",
  priceAtomic: "5000000000000000000000000",
  buyerCollateralAtomic: "1000000000000000000000000",
  sellerCollateralAtomic: "2000000000000000000000000",
  fundingDeadlineNs: "1800000000000000000",
  deliveryDeadlineNs: "1800003600000000000",
  confirmationDeadlineNs: "1800007200000000000",
  sellerTimeoutRule: "REFUND_BUYER_WITH_SELLER_COLLATERAL",
  buyerTimeoutRule: "AUTO_RELEASE_TO_SELLER",
  nonce: "agreement_nonce_000000000001",
  expiresAtNs: "1799999900000000000",
};

const buyerSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const teeSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const replyPublicKey = bytesToBase64Url(boxPublicKeyFromSecret(Uint8Array.from({ length: 32 }, (_, index) => 64 + index)));

describe("canonical private terms", () => {
  it("matches the checked-in cross-component protocol vector byte for byte", async () => {
    const vector = JSON.parse(
      await readFile(new URL("../fixtures/protocol-v1.json", import.meta.url), "utf8"),
    ) as Record<string, any>;
    const signingSeed = base64UrlToBytes(vector.buyerSigningSeedBase64Url);
    const replySecret = base64UrlToBytes(vector.buyerReplySecretBase64Url);
    const recipientSecret = base64UrlToBytes(vector.teeSecretBase64Url);
    expect(canonicalizeTerms(vector.terms)).toBe(vector.canonicalTerms);
    expect(hashTerms(vector.terms)).toBe(vector.termsHash);
    expect(publicKeyFromSeed(signingSeed)).toBe(vector.buyerPublicKey);
    expect(bytesToBase64Url(boxPublicKeyFromSecret(replySecret))).toBe(vector.buyerReplyPublicKeyBase64Url);

    const signed = signTerms({
      terms: vector.terms,
      role: "BUYER",
      signerId: vector.terms.buyerId,
      replyKeyId: "buyer-reply-v1",
      replyPublicKey: vector.buyerReplyPublicKeyBase64Url,
      submissionNonce: "buyer_submission_nonce_0001",
      signingSeed,
    });
    expect(signed).toEqual(vector.signedTerms);

    let nextByte = 0;
    const deterministicRandom = (length: number) =>
      Uint8Array.from({ length }, () => {
        nextByte = (nextByte + 17) % 256;
        return nextByte;
      });
    const envelope = encryptJsonForRecipient({
      payload: signed,
      recipientPublicKey: boxPublicKeyFromSecret(recipientSecret),
      recipientKeyId: "tee-key-v1",
      context: "airotc:terms-submission:v1",
      randomBytes: deterministicRandom,
    });
    expect(envelope).toEqual(vector.encryptedTermsEnvelope);
    expect(
      decryptJsonEnvelope({
        envelope,
        recipientSecretKey: recipientSecret,
        expectedKeyId: "tee-key-v1",
        expectedContext: "airotc:terms-submission:v1",
      }),
    ).toEqual(vector.signedTerms);
  });

  it("produces one stable canonical form and hash", () => {
    expect(canonicalizeTerms({ ...terms })).toBe(JSON.stringify(terms));
    expect(hashTerms(terms)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects floats, leading zeros, unknown fields, and unordered deadlines", () => {
    expect(() => canonicalizeTerms({ ...terms, priceAtomic: "1.5" })).toThrow();
    expect(() => canonicalizeTerms({ ...terms, priceAtomic: "01" })).toThrow();
    expect(() => canonicalizeTerms({ ...terms, extra: true })).toThrow();
    expect(() => canonicalizeTerms({ ...terms, deliveryDeadlineNs: "1" })).toThrow();
    expect(() =>
      canonicalizeTerms({
        ...terms,
        priceAtomic: ((1n << 128n) - 1n).toString(),
        buyerCollateralAtomic: "1",
      }),
    ).toThrow(/exceeds u128/);
  });
});

describe("signed terms", () => {
  it("signs and verifies a role-bound submission", () => {
    const signed = signTerms({
      terms,
      role: "BUYER",
      signerId: terms.buyerId,
      replyKeyId: "buyer-reply-v1",
      replyPublicKey,
      submissionNonce: "buyer_submission_nonce_0001",
      signingSeed: buyerSeed,
    });
    expect(signed.publicKey).toBe(publicKeyFromSeed(buyerSeed));
    expect(verifySignedTerms(signed)).toEqual(signed);
  });

  it("rejects role impersonation and tampering", () => {
    expect(() =>
      signTerms({
        terms,
        role: "SELLER",
        signerId: terms.buyerId,
        replyKeyId: "buyer-reply-v1",
        replyPublicKey,
        submissionNonce: "buyer_submission_nonce_0001",
        signingSeed: buyerSeed,
      }),
    ).toThrow(/Signer identity/);

    const signed = signTerms({
      terms,
      role: "BUYER",
      signerId: terms.buyerId,
      replyKeyId: "buyer-reply-v1",
      replyPublicKey,
      submissionNonce: "buyer_submission_nonce_0001",
      signingSeed: buyerSeed,
    });
    expect(() => verifySignedTerms({ ...signed, submissionNonce: "tampered_submission_nonce" })).toThrow(
      /Invalid terms signature/,
    );
  });
});

describe("encrypted envelopes", () => {
  it("round-trips and binds key id and context", () => {
    const publicKey = boxPublicKeyFromSecret(teeSecret);
    let nextByte = 0;
    const deterministicRandom = (length: number) =>
      Uint8Array.from({ length }, () => {
        nextByte = (nextByte + 17) % 256;
        return nextByte;
      });
    const envelope = encryptJsonForRecipient({
      payload: terms,
      recipientPublicKey: publicKey,
      recipientKeyId: "tee-key-v1",
      context: "airotc:terms-submission:v1",
      randomBytes: deterministicRandom,
    });
    expect(
      decryptJsonEnvelope<FinalTermsV1>({
        envelope,
        recipientSecretKey: teeSecret,
        expectedKeyId: "tee-key-v1",
        expectedContext: "airotc:terms-submission:v1",
      }),
    ).toEqual(terms);
    expect(() =>
      decryptJsonEnvelope({
        envelope,
        recipientSecretKey: teeSecret,
        expectedKeyId: "different-key",
        expectedContext: "airotc:terms-submission:v1",
      }),
    ).toThrow(/context mismatch/);
  });

  it("rejects modified ciphertext", () => {
    const envelope = encryptJsonForRecipient({
      payload: terms,
      recipientPublicKey: boxPublicKeyFromSecret(teeSecret),
      recipientKeyId: "tee-key-v1",
      context: "airotc:terms-submission:v1",
    });
    const ciphertext = base64UrlToBytes(envelope.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    expect(() =>
      decryptJsonEnvelope({
        envelope: { ...envelope, ciphertext: bytesToBase64Url(ciphertext) },
        recipientSecretKey: teeSecret,
        expectedKeyId: "tee-key-v1",
        expectedContext: "airotc:terms-submission:v1",
      }),
    ).toThrow(/authentication failed/);
  });
});

describe("deposit commitments", () => {
  it("is stable and rejects short secrets", () => {
    const secret = bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, index) => index));
    expect(createDepositCommitment(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => createDepositCommitment(bytesToBase64Url(new Uint8Array(8)))).toThrow(/32 bytes/);
  });
});

describe("signed worker actions", () => {
  it("binds an action to the actor, nonce, and expiry", () => {
    const publicKey = publicKeyFromSeed(buyerSeed);
    const signed = signWorkerAction({
      actorId: terms.buyerId,
      publicKey,
      replyKeyId: "buyer-reply-v1",
      replyPublicKey,
      nonce: "action_nonce_00000000000001",
      expiresAtNs: "1800000000000000000",
      action: { type: "CONFIRM_DELIVERY", ticketId: terms.ticketId },
      signingSeed: buyerSeed,
    });
    expect(verifySignedWorkerAction(signed)).toEqual(signed);
    expect(() =>
      verifySignedWorkerAction({
        ...signed,
        action: { type: "REQUEST_WITHDRAWAL", recipientId: terms.buyerId, amountAtomic: "1" },
      }),
    ).toThrow(/Invalid action signature/);
  });
});

describe("worker trust binding", () => {
  const identity = {
    workerId: "tee-worker.testnet",
    encryptionKeyId: "tee-key-v1",
    encryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(teeSecret)),
  };
  const nonce = "a".repeat(64);
  const reportData = workerAttestationReportData(identity, nonce);
  const response = {
    identity,
    binding: { version: 1 as const, nonce, reportData },
    evidence: {
      version: 1 as const,
      platform: "DSTACK_CVM" as const,
      reportData,
      attestationHex: "ab".repeat(64),
      appId: "ab",
      instanceId: "cd",
      composeHash: "b".repeat(64),
      osImageHash: "c".repeat(64),
      issuedAt: "2026-10-23T00:00:00.000Z",
    },
  };
  const policy = {
    workerId: identity.workerId,
    encryptionKeyHash: workerEncryptionKeyHash(identity),
    composeHash: response.evidence.composeHash,
  };

  it("accepts only the nonce-bound encryption identity approved by the pool", () => {
    expect(verifyWorkerAttestationBinding(response, nonce, policy)).toMatchObject({
      identity,
      platform: "DSTACK_CVM",
      composeHash: policy.composeHash,
    });
    const substitutedIdentity = { ...identity, encryptionPublicKey: bytesToBase64Url(boxPublicKeyFromSecret(new Uint8Array(32).fill(17))) };
    const substitutedReportData = workerAttestationReportData(substitutedIdentity, nonce);
    expect(() => verifyWorkerAttestationBinding({
      ...response,
      identity: substitutedIdentity,
      binding: { ...response.binding, reportData: substitutedReportData },
      evidence: { ...response.evidence, reportData: substitutedReportData },
    }, nonce, policy)).toThrow(/encryption identity/);
    expect(() => verifyWorkerAttestationBinding(response, "d".repeat(64), policy)).toThrow(/nonce binding/);
    expect(() => verifyWorkerAttestationBinding(response, nonce, { ...policy, composeHash: "e".repeat(64) })).toThrow(/compose hash/);
  });

  it("rejects development evidence unless the caller explicitly enables local mode", () => {
    const development = {
      ...response,
      evidence: { ...response.evidence, platform: "DEV_UNVERIFIED" as const, attestationHex: "" },
    };
    expect(() => verifyWorkerAttestationBinding(development, nonce, policy)).toThrow(/forbidden/);
    expect(verifyWorkerAttestationBinding(development, nonce, { ...policy, allowDevelopment: true }).platform).toBe("DEV_UNVERIFIED");
  });
});

describe("on-chain worker trust policy", () => {
  const config = {
    paused: false,
    tee_worker_id: "tee-worker.testnet",
    tee_encryption_key_hash: "a".repeat(64),
    tee_measurement_hash: "b".repeat(64),
  };
  const rpcFetcher = (value: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      result: { result: [...new TextEncoder().encode(JSON.stringify(value))] },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  it("loads the approved worker, encryption key, and measurement from final NEAR state", async () => {
    await expect(fetchNearPoolWorkerPolicy({
      rpcUrl: "https://rpc.testnet.near.org",
      contractId: "private-pool.testnet",
      fetcher: rpcFetcher(config),
    })).resolves.toEqual({
      workerId: config.tee_worker_id,
      encryptionKeyHash: config.tee_encryption_key_hash,
      composeHash: config.tee_measurement_hash,
    });
  });

  it("fails closed while the pool is paused", async () => {
    await expect(fetchNearPoolWorkerPolicy({
      rpcUrl: "https://rpc.testnet.near.org",
      contractId: "private-pool.testnet",
      fetcher: rpcFetcher({ ...config, paused: true }),
    })).rejects.toThrow(/pool is paused/);
  });
});

