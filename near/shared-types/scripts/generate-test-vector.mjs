import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  canonicalizeTerms,
  encryptJsonForRecipient,
  hashTerms,
  publicKeyFromSeed,
  signTerms,
} from "../dist/index.js";

const terms = {
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

const buyerSigningSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const buyerReplySecret = Uint8Array.from({ length: 32 }, (_, index) => index + 64);
const teeSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const buyerReplyPublic = boxPublicKeyFromSecret(buyerReplySecret);
const teePublic = boxPublicKeyFromSecret(teeSecret);
const signedTerms = signTerms({
  terms,
  role: "BUYER",
  signerId: terms.buyerId,
  replyKeyId: "buyer-reply-v1",
  replyPublicKey: bytesToBase64Url(buyerReplyPublic),
  submissionNonce: "buyer_submission_nonce_0001",
  signingSeed: buyerSigningSeed,
});
let nextByte = 0;
const deterministicRandom = (length) =>
  Uint8Array.from({ length }, () => {
    nextByte = (nextByte + 17) % 256;
    return nextByte;
  });
const envelope = encryptJsonForRecipient({
  payload: signedTerms,
  recipientPublicKey: teePublic,
  recipientKeyId: "tee-key-v1",
  context: "airotc:terms-submission:v1",
  randomBytes: deterministicRandom,
});

const vector = {
  warning: "Public deterministic test keys only; never use these keys outside tests.",
  version: 1,
  terms,
  canonicalTerms: canonicalizeTerms(terms),
  termsHash: hashTerms(terms),
  buyerSigningSeedBase64Url: bytesToBase64Url(buyerSigningSeed),
  buyerPublicKey: publicKeyFromSeed(buyerSigningSeed),
  buyerReplySecretBase64Url: bytesToBase64Url(buyerReplySecret),
  buyerReplyPublicKeyBase64Url: bytesToBase64Url(buyerReplyPublic),
  teeSecretBase64Url: bytesToBase64Url(teeSecret),
  teePublicKeyBase64Url: bytesToBase64Url(teePublic),
  signedTerms,
  encryptedTermsEnvelope: envelope,
};

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, "protocol-v1.json"), `${JSON.stringify(vector, null, 2)}\n`, "utf8");
