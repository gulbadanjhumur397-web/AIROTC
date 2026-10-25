import {
  bytesToHex,
  canonicalObjectJson,
  domainSeparatedHash,
  utf8,
  verifyWorkerAttestationBinding,
  type EncryptedEnvelopeV1,
  type FinalTermsV1,
  type PartyRole,
  type VerifiedWorkerBinding,
  type WorkerAction,
  type WorkerTrustPolicyV1,
} from "@air-otc/shared-types";
import { decryptFor, encryptFor, requestId, sessionBoxPublicKey, signedAction, signedTerms, type SessionMaterial } from "./session-vault.js";

export interface WorkerIdentity { workerId: string; encryptionKeyId: string; encryptionPublicKey: string }
export type BrowserWorkerPolicyProvider = () => Promise<WorkerTrustPolicyV1>;

export class BrowserDealClient {
  private token = "";
  constructor(
    readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly workerPolicy?: BrowserWorkerPolicyProvider,
  ) {}
  hasToken(): boolean { return this.token !== ""; }
  setToken(token: string): void { if (!token.startsWith("airotc_near_")) throw new Error("Invalid token"); this.token = token; }
  clearToken(): void { this.token = ""; }

  challenge(grant: unknown): Promise<any> { return this.request("POST", "/v1/auth/challenge", grant, false); }
  issue(proof: unknown): Promise<any> { return this.request("POST", "/v1/auth/token", proof, false); }
  identity(): Promise<WorkerIdentity> { return this.request("GET", "/v1/worker/identity", undefined, false) as Promise<WorkerIdentity>; }
  attestation(nonce: string): Promise<any> { return this.request("GET", `/v1/worker/attestation?nonce=${encodeURIComponent(nonce)}`, undefined, false); }
  async verifyWorker(nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))): Promise<VerifiedWorkerBinding> {
    if (!this.workerPolicy) throw new Error("TEE trust policy is not configured");
    const [attestation, policy] = await Promise.all([this.attestation(nonce), this.workerPolicy()]);
    return verifyWorkerAttestationBinding(attestation, nonce, policy);
  }
  listings(): Promise<any> { return this.request("GET", "/v1/listings"); }
  tickets(): Promise<any> { return this.request("GET", "/v1/tickets"); }
  ticket(ticketRef: string): Promise<any> { return this.request("GET", `/v1/tickets/${encodeURIComponent(ticketRef)}`); }

  async createListing(session: SessionMaterial, kind: string, product: Record<string, unknown>): Promise<any> {
    return this.mutate("POST", "/v1/listings", {
      kind, tagHashes: [], sellerEncryptionKeyId: session.keyId,
      sellerEncryptionPublicKey: sessionBoxPublicKey(session),
      encryptedProduct: encryptFor(product, sessionBoxPublicKey(session), session.keyId, "airotc:listing:v1"),
    });
  }

  async createTicket(session: SessionMaterial, listingRef: string): Promise<any> {
    return this.mutate("POST", "/v1/tickets", { listingRef, buyerEncryptionKeyId: session.keyId, buyerEncryptionPublicKey: sessionBoxPublicKey(session) });
  }

  async messages(session: SessionMaterial, ticketRef: string): Promise<any[]> {
    const result = await this.request("GET", `/v1/tickets/${encodeURIComponent(ticketRef)}/messages`) as { messages: any[] };
    return result.messages.map((message) => {
      const envelope = message.buyerEnvelope.recipientKeyId === session.keyId ? message.buyerEnvelope : message.sellerEnvelope;
      return { ...message, payload: decryptFor(session, envelope), buyerEnvelope: undefined, sellerEnvelope: undefined };
    });
  }

  async sendMessage(_session: SessionMaterial, ticketRef: string, message: string): Promise<any> {
    const ticket = await this.ticket(ticketRef);
    const payload = { message, sentAtNs: (BigInt(Date.now()) * 1_000_000n).toString() };
    return this.mutate("POST", `/v1/tickets/${encodeURIComponent(ticketRef)}/messages`, {
      buyerEnvelope: encryptFor(payload, ticket.buyerEncryptionPublicKey, ticket.buyerEncryptionKeyId, "airotc:ticket-message:v1"),
      sellerEnvelope: encryptFor(payload, ticket.sellerEncryptionPublicKey, ticket.sellerEncryptionKeyId, "airotc:ticket-message:v1"),
    });
  }

  async submitTerms(session: SessionMaterial, accountId: string, role: PartyRole, terms: FinalTermsV1): Promise<any> {
    const identity = (await this.verifyWorker()).identity;
    const envelope = encryptFor(signedTerms(session, accountId, role, terms), identity.encryptionPublicKey, identity.encryptionKeyId, "airotc:terms-submission:v1");
    return this.workerResult(session, await this.mutate("POST", `/v1/worker/terms/${role.toLowerCase()}`, { envelope }));
  }

  async workerAction(session: SessionMaterial, accountId: string, action: WorkerAction, category: "pool" | "pool-read" | "delivery-seller" | "delivery-buyer" | "withdrawal", spendAtomic?: string): Promise<any> {
    const identity = (await this.verifyWorker()).identity;
    const envelope = encryptFor(signedAction(session, accountId, action), identity.encryptionPublicKey, identity.encryptionKeyId, "airotc:worker-action:v1");
    return this.mutate("POST", `/v1/worker/actions/${category}`, { envelope }, spendAtomic).then((value) => this.workerResult(session, value));
  }

  async storeDelivery(_session: SessionMaterial, ticketRef: string, delivery: Record<string, unknown>): Promise<any> {
    const ticket = await this.ticket(ticketRef);
    const deliveryCommitment = domainSeparatedHash("airotc:delivery:v1", utf8(canonicalObjectJson(delivery)));
    return this.mutate("PUT", `/v1/tickets/${encodeURIComponent(ticketRef)}/delivery`, {
      deliveryCommitment,
      buyerEnvelope: encryptFor(delivery, ticket.buyerEncryptionPublicKey, ticket.buyerEncryptionKeyId, "airotc:delivery:v1"),
    });
  }

  async delivery(session: SessionMaterial, ticketRef: string): Promise<any> {
    const result = await this.request("GET", `/v1/tickets/${encodeURIComponent(ticketRef)}/delivery`) as any;
    return result.delivery === null ? null : { ...result.delivery, payload: decryptFor(session, result.delivery.buyerEnvelope), buyerEnvelope: undefined };
  }

  async rotate(): Promise<unknown> { const value = await this.mutate("POST", "/v1/auth/rotate", {}) as { token: string }; this.setToken(value.token); return value; }
  async revoke(): Promise<void> { await this.mutate("POST", "/v1/auth/revoke", {}); this.clearToken(); }

  private workerResult(session: SessionMaterial, value: any): any {
    const result = decryptFor<any>(session, value.envelope as EncryptedEnvelopeV1);
    if (result?.ok === false) throw new Error(result.error?.message ?? "Confidential worker rejected the request");
    return result;
  }
  private mutate(method: "POST" | "PUT", path: string, body: unknown, spendAtomic?: string): Promise<unknown> { return this.request(method, path, body, true, requestId(), spendAtomic); }
  private async request(method: string, path: string, body?: unknown, authenticated = true, mutationId?: string, spendAtomic?: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) { if (!this.token) throw new Error("Create an access token first"); headers.authorization = `Bearer ${this.token}`; }
    if (mutationId) headers["x-airotc-request-id"] = mutationId;
    if (spendAtomic) headers["x-airotc-spend-atomic"] = spendAtomic;
    const response = await this.fetcher(`${this.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(value?.error?.message ?? "Request failed");
    return value;
  }
}
