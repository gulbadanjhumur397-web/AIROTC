import type { EncryptedEnvelopeV1 } from "@air-otc/shared-types";

export const API_STATE_VERSION = 1 as const;

export type Scope =
  | "marketplace:read"
  | "marketplace:write"
  | "tickets:read"
  | "tickets:write"
  | "terms:submit"
  | "pool:read"
  | "pool:write"
  | "delivery:read"
  | "delivery:write"
  | "withdrawals:write"
  | "tokens:rotate"
  | "tokens:revoke";

export type PartyRole = "BUYER" | "SELLER";

export interface SpendingPolicy {
  maxWithdrawalAtomic: string;
  maxCumulativeWithdrawalAtomic: string;
}

export interface TokenRecord {
  tokenId: string;
  tokenHash: string;
  walletId: string;
  walletHandle: string;
  scopes: Scope[];
  roles: PartyRole[];
  policy: SpendingPolicy;
  withdrawnAtomic: string;
  createdAtNs: string;
  expiresAtNs: string;
  revokedAtNs: string;
  rotation: number;
}

export interface ListingRecord {
  listingRef: string;
  sellerId: string;
  sellerHandle: string;
  sellerEncryptionKeyId: string;
  sellerEncryptionPublicKey: string;
  kind: "API_ACCESS" | "DIGITAL_ASSET" | "SERVICE" | "OTHER";
  tagHashes: string[];
  encryptedProduct: EncryptedEnvelopeV1;
  status: "ACTIVE" | "CLOSED";
  createdAtNs: string;
}

export interface TicketRecord {
  ticketRef: string;
  listingRef: string;
  buyerId: string;
  sellerId: string;
  buyerHandle: string;
  sellerHandle: string;
  buyerEncryptionKeyId: string;
  buyerEncryptionPublicKey: string;
  sellerEncryptionKeyId: string;
  sellerEncryptionPublicKey: string;
  status: "NEGOTIATING" | "TERMS_PENDING" | "FUNDED" | "DELIVERED" | "COMPLETED" | "CANCELLED";
  createdAtNs: string;
}

export interface TicketMessageRecord {
  messageRef: string;
  ticketRef: string;
  senderRole: PartyRole;
  sequence: number;
  buyerEnvelope: EncryptedEnvelopeV1;
  sellerEnvelope: EncryptedEnvelopeV1;
  createdAtNs: string;
}

export interface DeliveryRecord {
  deliveryRef: string;
  ticketRef: string;
  deliveryCommitment: string;
  buyerEnvelope: EncryptedEnvelopeV1;
  createdAtNs: string;
}

export interface ApiStateV1 {
  version: typeof API_STATE_VERSION;
  revision: string;
  tokens: Record<string, TokenRecord>;
  listings: Record<string, ListingRecord>;
  tickets: Record<string, TicketRecord>;
  messages: Record<string, TicketMessageRecord[]>;
  deliveries: Record<string, DeliveryRecord>;
  usedRequests: Record<string, string>;
}

export interface AuthContext {
  tokenId: string;
  walletId: string;
  walletHandle: string;
  scopes: ReadonlySet<Scope>;
  roles: ReadonlySet<PartyRole>;
  policy: SpendingPolicy;
  withdrawnAtomic: string;
  expiresAtNs: string;
}

export interface Clock {
  nowNs(): bigint;
}

export interface StateDatabase {
  load(): Promise<ApiStateV1 | null>;
  save(state: ApiStateV1): Promise<void>;
}

export interface IdentityVerifier {
  isAuthorizedKey(accountId: string, publicKey: string): Promise<boolean>;
}
