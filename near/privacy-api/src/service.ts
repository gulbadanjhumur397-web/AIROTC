import { randomBytes } from "node:crypto";
import { domainSeparatedHash, utf8, type EncryptedEnvelopeV1 } from "@air-otc/shared-types";
import { TokenService, type SignedTokenChallenge, type TokenGrant } from "./token-service.js";
import type {
  ApiStateV1,
  AuthContext,
  Clock,
  DeliveryRecord,
  ListingRecord,
  Scope,
  StateDatabase,
  TicketMessageRecord,
  TicketRecord,
} from "./types.js";
import {
  requireAccountId,
  requireEnvelope,
  requireHash,
  requireHashList,
  requireKey,
  requireOpaqueRef,
  requireRecord,
  requireBoxPublicKey,
} from "./validation.js";
import { emptyState, validateDatabaseState } from "./store.js";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WorkerProxy {
  identity(): Promise<unknown>;
  attestation(nonce: string): Promise<unknown>;
  terms(envelope: EncryptedEnvelopeV1): Promise<unknown>;
  action(envelope: EncryptedEnvelopeV1, withdrawalAmountCommitment?: string): Promise<unknown>;
}

export class HttpWorkerProxy implements WorkerProxy {
  constructor(private readonly baseUrl: string) {}

  identity(): Promise<unknown> {
    return this.get("/v1/identity");
  }

  attestation(nonce: string): Promise<unknown> {
    if (!/^[0-9a-f]{64}$/.test(nonce)) throw new ApiError("INVALID_NONCE", "Attestation nonce is invalid", 400);
    return this.get(`/v1/attestation?nonce=${encodeURIComponent(nonce)}`);
  }

  terms(envelope: EncryptedEnvelopeV1): Promise<unknown> {
    return this.post("/v1/terms", { envelope });
  }

  action(envelope: EncryptedEnvelopeV1, withdrawalAmountCommitment?: string): Promise<unknown> {
    return this.post("/v1/actions", { envelope, ...(withdrawalAmountCommitment === undefined ? {} : { withdrawalAmountCommitment }) });
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    return responseJson(response);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return responseJson(response);
  }
}

export class PrivacyApiService {
  private state: ApiStateV1 = emptyState();
  private initialized = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: StateDatabase,
    readonly tokens: TokenService,
    private readonly worker: WorkerProxy,
    private readonly clock: Clock,
  ) {}

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      this.state = validateDatabaseState((await this.database.load()) ?? emptyState());
      this.initialized = true;
    });
  }

  createTokenChallenge(value: unknown) {
    this.ready();
    return this.tokens.createChallenge(value);
  }

  async issueToken(proof: SignedTokenChallenge): Promise<Record<string, unknown>> {
    return this.mutate(async () => {
      const issued = await this.tokens.issueFromChallenge(this.state, proof);
      return publicToken(issued.token, issued.record);
    });
  }

  async issueTokenForTesting(grant: TokenGrant): Promise<{ token: string; tokenId: string }> {
    return this.mutate(() => {
      const issued = this.tokens.issueForTesting(this.state, grant);
      return { token: issued.token, tokenId: issued.record.tokenId };
    });
  }

  authenticate(rawToken: string): AuthContext {
    this.ready();
    try {
      return this.tokens.authenticate(this.state, rawToken);
    } catch (error) {
      throw new ApiError("UNAUTHORIZED", error instanceof Error ? error.message : "Unauthorized", 401);
    }
  }

  async rotateToken(auth: AuthContext, requestId: string): Promise<Record<string, unknown>> {
    return this.mutate(() => {
      this.consumeRequest(auth, requestId);
      const issued = this.tokens.rotate(this.state, auth);
      return publicToken(issued.token, issued.record);
    });
  }

  async revokeToken(auth: AuthContext, requestId: string): Promise<{ status: "REVOKED" }> {
    return this.mutate(() => {
      this.consumeRequest(auth, requestId);
      this.tokens.revoke(this.state, auth);
      return { status: "REVOKED" };
    });
  }

  async createListing(auth: AuthContext, requestId: string, value: unknown): Promise<ListingRecord> {
    return this.mutate(() => {
      this.tokens.requireScope(auth, "marketplace:write");
      this.tokens.requireRole(auth, "SELLER");
      this.consumeRequest(auth, requestId);
      const input = requireRecord(value, "listing");
      const kind = input.kind;
      if (kind !== "API_ACCESS" && kind !== "DIGITAL_ASSET" && kind !== "SERVICE" && kind !== "OTHER") {
        throw new ApiError("INVALID_LISTING", "Listing kind is invalid", 400);
      }
      const listingRef = opaque("listing");
      const listing: ListingRecord = {
        listingRef,
        sellerId: auth.walletId,
        sellerHandle: auth.walletHandle,
        sellerEncryptionKeyId: requireKey(input.sellerEncryptionKeyId, "sellerEncryptionKeyId"),
        sellerEncryptionPublicKey: requireBoxPublicKey(input.sellerEncryptionPublicKey, "sellerEncryptionPublicKey"),
        kind,
        tagHashes: requireHashList(input.tagHashes),
        encryptedProduct: requireEnvelope(input.encryptedProduct, "airotc:listing:v1"),
        status: "ACTIVE",
        createdAtNs: this.clock.nowNs().toString(),
      };
      this.state.listings[listingRef] = listing;
      return structuredClone(listing);
    });
  }

  listListings(auth: AuthContext, tagHash?: string): ListingRecord[] {
    this.tokens.requireScope(auth, "marketplace:read");
    if (tagHash !== undefined) requireHash(tagHash, "tagHash");
    return Object.values(this.state.listings)
      .filter((listing) => listing.status === "ACTIVE" && (tagHash === undefined || listing.tagHashes.includes(tagHash)))
      .sort((left, right) => left.createdAtNs.localeCompare(right.createdAtNs))
      .map((listing) => structuredClone(listing));
  }

  async createTicket(auth: AuthContext, requestId: string, value: unknown): Promise<TicketRecord> {
    return this.mutate(() => {
      this.tokens.requireScope(auth, "tickets:write");
      this.tokens.requireRole(auth, "BUYER");
      this.consumeRequest(auth, requestId);
      const input = requireRecord(value, "ticket");
      const listingRef = requireOpaqueRef(input.listingRef, "listingRef");
      const listing = this.state.listings[listingRef];
      if (!listing || listing.status !== "ACTIVE") throw new ApiError("LISTING_NOT_FOUND", "Listing is unavailable", 404);
      if (listing.sellerHandle === auth.walletHandle) throw new ApiError("SELF_DEAL", "Seller cannot buy their own listing", 409);
      const ticketRef = opaque("ticket");
      const ticket: TicketRecord = {
        ticketRef,
        listingRef,
        buyerId: auth.walletId,
        sellerId: listing.sellerId,
        buyerHandle: auth.walletHandle,
        sellerHandle: listing.sellerHandle,
        buyerEncryptionKeyId: requireKey(input.buyerEncryptionKeyId, "buyerEncryptionKeyId"),
        buyerEncryptionPublicKey: requireBoxPublicKey(input.buyerEncryptionPublicKey, "buyerEncryptionPublicKey"),
        sellerEncryptionKeyId: listing.sellerEncryptionKeyId,
        sellerEncryptionPublicKey: listing.sellerEncryptionPublicKey,
        status: "NEGOTIATING",
        createdAtNs: this.clock.nowNs().toString(),
      };
      this.state.tickets[ticketRef] = ticket;
      this.state.messages[ticketRef] = [];
      return structuredClone(ticket);
    });
  }

  listTickets(auth: AuthContext): TicketRecord[] {
    this.tokens.requireScope(auth, "tickets:read");
    return Object.values(this.state.tickets)
      .filter((ticket) => this.isParty(auth, ticket))
      .map((ticket) => structuredClone(ticket));
  }

  getTicket(auth: AuthContext, ticketRef: string): TicketRecord {
    this.tokens.requireScope(auth, "tickets:read");
    return structuredClone(this.requireParty(auth, ticketRef));
  }

  async addMessage(auth: AuthContext, requestId: string, ticketRef: string, value: unknown): Promise<TicketMessageRecord> {
    return this.mutate(() => {
      this.tokens.requireScope(auth, "tickets:write");
      this.consumeRequest(auth, requestId);
      const ticket = this.requireParty(auth, ticketRef);
      const input = requireRecord(value, "ticket message");
      const messages = this.state.messages[ticket.ticketRef] ?? [];
      const record: TicketMessageRecord = {
        messageRef: opaque("message"),
        ticketRef: ticket.ticketRef,
        senderRole: auth.walletHandle === ticket.buyerHandle ? "BUYER" : "SELLER",
        sequence: messages.length + 1,
        buyerEnvelope: requireEnvelope(input.buyerEnvelope, "airotc:ticket-message:v1"),
        sellerEnvelope: requireEnvelope(input.sellerEnvelope, "airotc:ticket-message:v1"),
        createdAtNs: this.clock.nowNs().toString(),
      };
      messages.push(record);
      this.state.messages[ticket.ticketRef] = messages;
      return structuredClone(record);
    });
  }

  listMessages(auth: AuthContext, ticketRef: string): TicketMessageRecord[] {
    this.tokens.requireScope(auth, "tickets:read");
    this.requireParty(auth, ticketRef);
    return structuredClone(this.state.messages[ticketRef] ?? []);
  }

  async putDelivery(auth: AuthContext, requestId: string, ticketRef: string, value: unknown): Promise<DeliveryRecord> {
    return this.mutate(() => {
      this.tokens.requireScope(auth, "delivery:write");
      this.tokens.requireRole(auth, "SELLER");
      this.consumeRequest(auth, requestId);
      const ticket = this.requireParty(auth, ticketRef);
      if (auth.walletHandle !== ticket.sellerHandle) throw new ApiError("SELLER_ONLY", "Only the seller can deliver", 403);
      if (this.state.deliveries[ticketRef]) throw new ApiError("DELIVERY_EXISTS", "Delivery already exists", 409);
      const input = requireRecord(value, "delivery");
      const record: DeliveryRecord = {
        deliveryRef: opaque("delivery"),
        ticketRef,
        deliveryCommitment: requireHash(input.deliveryCommitment, "deliveryCommitment"),
        buyerEnvelope: requireEnvelope(input.buyerEnvelope, "airotc:delivery:v1"),
        createdAtNs: this.clock.nowNs().toString(),
      };
      this.state.deliveries[ticketRef] = record;
      ticket.status = "DELIVERED";
      return structuredClone(record);
    });
  }

  getDelivery(auth: AuthContext, ticketRef: string): DeliveryRecord | null {
    this.tokens.requireScope(auth, "delivery:read");
    const ticket = this.requireParty(auth, ticketRef);
    if (auth.walletHandle !== ticket.buyerHandle) throw new ApiError("BUYER_ONLY", "Only the buyer can read delivery", 403);
    return structuredClone(this.state.deliveries[ticketRef] ?? null);
  }

  workerIdentity(): Promise<unknown> {
    return this.worker.identity();
  }

  workerAttestation(nonce: string): Promise<unknown> {
    return this.worker.attestation(nonce);
  }

  async submitTerms(auth: AuthContext, requestId: string, role: "BUYER" | "SELLER", value: unknown): Promise<unknown> {
    this.tokens.requireRole(auth, role);
    return this.proxyMutation(auth, requestId, "terms:submit", "airotc:terms-submission:v1", value, "terms");
  }

  async submitAction(
    auth: AuthContext,
    requestId: string,
    scope: Scope,
    value: unknown,
    spendAtomic?: string,
    requiredRole?: "BUYER" | "SELLER",
  ): Promise<unknown> {
    if (requiredRole !== undefined) this.tokens.requireRole(auth, requiredRole);
    return this.proxyMutation(auth, requestId, scope, "airotc:worker-action:v1", value, "action", spendAtomic);
  }

  snapshotForTesting(): ApiStateV1 {
    return structuredClone(this.state);
  }

  private async proxyMutation(
    auth: AuthContext,
    requestId: string,
    scope: Scope,
    context: string,
    value: unknown,
    type: "terms" | "action",
    spendAtomic?: string,
  ): Promise<unknown> {
    return this.mutate(async () => {
      this.tokens.requireScope(auth, scope);
      this.consumeRequest(auth, requestId);
      const input = requireRecord(value, "TEE proxy request");
      const envelope = requireEnvelope(input.envelope, context);
      if (scope === "withdrawals:write") {
        if (spendAtomic === undefined || !/^[1-9][0-9]*$/.test(spendAtomic)) {
          throw new ApiError("SPEND_REQUIRED", "Withdrawal policy amount is required", 400);
        }
        this.tokens.reserveWithdrawal(this.state, auth, spendAtomic);
      }
      const withdrawalAmountCommitment = spendAtomic === undefined
        ? undefined
        : domainSeparatedHash("airotc:withdrawal-policy:v1", utf8(spendAtomic));
      return type === "terms" ? this.worker.terms(envelope) : this.worker.action(envelope, withdrawalAmountCommitment);
    });
  }

  private requireParty(auth: AuthContext, ticketRef: string): TicketRecord {
    requireOpaqueRef(ticketRef, "ticketRef");
    const ticket = this.state.tickets[ticketRef];
    if (!ticket) throw new ApiError("TICKET_NOT_FOUND", "Ticket not found", 404);
    if (!this.isParty(auth, ticket)) throw new ApiError("TICKET_ACCESS_DENIED", "Token wallet is not a ticket party", 403);
    return ticket;
  }

  private isParty(auth: AuthContext, ticket: TicketRecord): boolean {
    return auth.walletHandle === ticket.buyerHandle || auth.walletHandle === ticket.sellerHandle;
  }

  private consumeRequest(auth: AuthContext, requestId: string): void {
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(requestId)) throw new ApiError("INVALID_REQUEST_ID", "Request ID is invalid", 400);
    const key = `${auth.tokenId}:${requestId}`;
    if (this.state.usedRequests[key]) throw new ApiError("REQUEST_REPLAY", "Request ID was already used", 409);
    this.state.usedRequests[key] = this.clock.nowNs().toString();
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.ready();
      const before = structuredClone(this.state);
      try {
        const result = await operation();
        this.state.revision = (BigInt(this.state.revision) + 1n).toString();
        await this.database.save(this.state);
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private ready(): void {
    if (!this.initialized) throw new ApiError("NOT_READY", "Privacy API is not initialized", 503);
  }
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function publicToken(token: string, record: { tokenId: string; walletId: string; scopes: Scope[]; roles: string[]; policy: unknown; expiresAtNs: string; rotation: number }): Record<string, unknown> {
  return {
    token,
    tokenId: record.tokenId,
    walletId: record.walletId,
    scopes: record.scopes,
    roles: record.roles,
    policy: record.policy,
    expiresAtNs: record.expiresAtNs,
    rotation: record.rotation,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({ error: { code: "UPSTREAM_INVALID", message: "Invalid worker response" } }));
  if (!response.ok) throw new ApiError("WORKER_REJECTED", "Confidential worker rejected the request", 502);
  return body;
}
