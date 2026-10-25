import { canonicalObjectJson, utf8 } from "./encoding.js";
import { domainSeparatedHash, isSha256Hex } from "./hash.js";

export const TERMS_VERSION = 1 as const;
export const TERMS_HASH_DOMAIN = "airotc:private-terms:v1";
export const SELLER_TIMEOUT_RULE = "REFUND_BUYER_WITH_SELLER_COLLATERAL" as const;
export const BUYER_TIMEOUT_RULE = "AUTO_RELEASE_TO_SELLER" as const;

export interface FinalTermsV1 {
  version: typeof TERMS_VERSION;
  ticketId: string;
  buyerId: string;
  sellerId: string;
  assetDescriptionHash: string;
  currency: "NEAR_TESTNET";
  priceAtomic: string;
  buyerCollateralAtomic: string;
  sellerCollateralAtomic: string;
  fundingDeadlineNs: string;
  deliveryDeadlineNs: string;
  confirmationDeadlineNs: string;
  sellerTimeoutRule: typeof SELLER_TIMEOUT_RULE;
  buyerTimeoutRule: typeof BUYER_TIMEOUT_RULE;
  nonce: string;
  expiresAtNs: string;
}

const TERM_KEYS = [
  "version",
  "ticketId",
  "buyerId",
  "sellerId",
  "assetDescriptionHash",
  "currency",
  "priceAtomic",
  "buyerCollateralAtomic",
  "sellerCollateralAtomic",
  "fundingDeadlineNs",
  "deliveryDeadlineNs",
  "confirmationDeadlineNs",
  "sellerTimeoutRule",
  "buyerTimeoutRule",
  "nonce",
  "expiresAtNs",
] as const;

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} contains missing or unsupported fields`);
  }
}

function requireAscii(value: unknown, field: string, min: number, max: number, pattern: RegExp): string {
  if (typeof value !== "string" || value.length < min || value.length > max || !pattern.test(value)) {
    throw new Error(`${field} has an invalid format`);
  }
  return value;
}

export function requireUnsignedInteger(value: unknown, field: string, allowZero = true): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned integer string`);
  }
  const number = BigInt(value);
  if (!allowZero && number === 0n) throw new Error(`${field} must be greater than zero`);
  if (number > (1n << 128n) - 1n) throw new Error(`${field} exceeds u128`);
  return value;
}

export function normalizeTerms(value: unknown): FinalTermsV1 {
  const object = requireObject(value, "terms");
  requireExactKeys(object, TERM_KEYS, "terms");

  if (object.version !== TERMS_VERSION) throw new Error("Unsupported terms version");
  const ticketId = requireAscii(object.ticketId, "ticketId", 16, 128, /^[A-Za-z0-9_-]+$/);
  const buyerId = requireAscii(object.buyerId, "buyerId", 2, 64, /^[a-z0-9._-]+$/);
  const sellerId = requireAscii(object.sellerId, "sellerId", 2, 64, /^[a-z0-9._-]+$/);
  if (buyerId === sellerId) throw new Error("Buyer and seller must be different");
  if (!isSha256Hex(object.assetDescriptionHash)) {
    throw new Error("assetDescriptionHash must be a lowercase SHA-256 hash");
  }
  if (object.currency !== "NEAR_TESTNET") throw new Error("Unsupported currency");

  const priceAtomic = requireUnsignedInteger(object.priceAtomic, "priceAtomic", false);
  const buyerCollateralAtomic = requireUnsignedInteger(object.buyerCollateralAtomic, "buyerCollateralAtomic");
  const sellerCollateralAtomic = requireUnsignedInteger(object.sellerCollateralAtomic, "sellerCollateralAtomic");
  if (BigInt(priceAtomic) + BigInt(buyerCollateralAtomic) > (1n << 128n) - 1n) {
    throw new Error("Buyer funding requirement exceeds u128");
  }
  if (BigInt(priceAtomic) + BigInt(sellerCollateralAtomic) > (1n << 128n) - 1n) {
    throw new Error("Seller settlement amount exceeds u128");
  }
  const fundingDeadlineNs = requireUnsignedInteger(object.fundingDeadlineNs, "fundingDeadlineNs", false);
  const deliveryDeadlineNs = requireUnsignedInteger(object.deliveryDeadlineNs, "deliveryDeadlineNs", false);
  const confirmationDeadlineNs = requireUnsignedInteger(object.confirmationDeadlineNs, "confirmationDeadlineNs", false);
  const expiresAtNs = requireUnsignedInteger(object.expiresAtNs, "expiresAtNs", false);

  if (object.sellerTimeoutRule !== SELLER_TIMEOUT_RULE) throw new Error("Unsupported sellerTimeoutRule");
  if (object.buyerTimeoutRule !== BUYER_TIMEOUT_RULE) throw new Error("Unsupported buyerTimeoutRule");
  const nonce = requireAscii(object.nonce, "nonce", 22, 128, /^[A-Za-z0-9_-]+$/);

  const funding = BigInt(fundingDeadlineNs);
  const delivery = BigInt(deliveryDeadlineNs);
  const confirmation = BigInt(confirmationDeadlineNs);
  const expiry = BigInt(expiresAtNs);
  if (funding > delivery || delivery > confirmation) throw new Error("Deal deadlines must be ordered");
  if (expiry > funding) throw new Error("Terms submission expiry cannot exceed the funding deadline");

  return {
    version: TERMS_VERSION,
    ticketId,
    buyerId,
    sellerId,
    assetDescriptionHash: object.assetDescriptionHash,
    currency: "NEAR_TESTNET",
    priceAtomic,
    buyerCollateralAtomic,
    sellerCollateralAtomic,
    fundingDeadlineNs,
    deliveryDeadlineNs,
    confirmationDeadlineNs,
    sellerTimeoutRule: SELLER_TIMEOUT_RULE,
    buyerTimeoutRule: BUYER_TIMEOUT_RULE,
    nonce,
    expiresAtNs,
  };
}

export function canonicalizeTerms(value: unknown): string {
  return canonicalObjectJson(normalizeTerms(value) as unknown as Record<string, unknown>);
}

export function hashTerms(value: unknown): string {
  return domainSeparatedHash(TERMS_HASH_DOMAIN, utf8(canonicalizeTerms(value)));
}

