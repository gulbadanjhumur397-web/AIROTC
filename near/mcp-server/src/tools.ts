import { randomBytes } from "node:crypto";
import {
  boxPublicKeyFromSecret,
  bytesToBase64Url,
  canonicalObjectJson,
  decryptJsonEnvelope,
  domainSeparatedHash,
  encryptJsonForRecipient,
  publicKeyFromSeed,
  signTerms,
  signWorkerAction,
  utf8,
  type EncryptedEnvelopeV1,
  type FinalTermsV1,
  type WorkerAction,
} from "@air-otc/shared-types";
import { PrivacyApiClient } from "./api-client.js";
import type { VerifiedWorkerProvider } from "./worker-trust.js";

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface AgentToolsOptions {
  api: PrivacyApiClient;
  accountId: string;
  signingSeed: Uint8Array;
  boxSecretKey: Uint8Array;
  boxKeyId: string;
  verifiedWorker: VerifiedWorkerProvider;
  nowNs?: () => bigint;
}

const TOOL_NAMES = [
  "marketplace_list", "marketplace_create", "ticket_create", "ticket_list", "ticket_get", "ticket_messages",
  "ticket_send_message", "terms_submit", "pool_identity", "pool_attestation", "pool_claim_deposit", "pool_get_balance",
  "delivery_store", "delivery_get", "delivery_submit", "delivery_confirm", "deal_status", "deal_cancel", "deal_timeout",
  "withdrawal_request", "token_rotate", "token_revoke",
] as const;

export class AgentTools {
  private readonly publicKey: string;
  private readonly boxPublicKey: Uint8Array;
  private readonly nowNs: () => bigint;

  constructor(private readonly options: AgentToolsOptions) {
    if (options.signingSeed.length !== 32 || options.boxSecretKey.length !== 32) throw new Error("MCP key material must contain 32 bytes");
    this.publicKey = publicKeyFromSeed(options.signingSeed);
    this.boxPublicKey = boxPublicKeyFromSecret(options.boxSecretKey);
    this.nowNs = options.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  }

  list(): ToolDefinition[] {
    return TOOL_NAMES.map((name) => definition(name));
  }

  async call(name: string, value: unknown): Promise<unknown> {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) throw new Error("UNKNOWN_TOOL: Tool is not available");
    const input = record(value);
    switch (name) {
      case "marketplace_list": return this.options.api.get(`/v1/listings${query(input.tagHash, "tagHash")}`);
      case "marketplace_create": return this.createListing(input);
      case "ticket_create": return this.options.api.mutate("POST", "/v1/tickets", requestId(input), {
        listingRef: text(input.listingRef, "listingRef"),
        buyerEncryptionKeyId: this.options.boxKeyId,
        buyerEncryptionPublicKey: bytesToBase64Url(this.boxPublicKey),
      });
      case "ticket_list": return this.options.api.get("/v1/tickets");
      case "ticket_get": return this.options.api.get(`/v1/tickets/${encodeURIComponent(text(input.ticketRef, "ticketRef"))}`);
      case "ticket_messages": return this.readMessages(input);
      case "ticket_send_message": return this.sendMessage(input);
      case "terms_submit": return this.submitTerms(input);
      case "pool_identity": {
        const verified = await this.options.verifiedWorker();
        return { ...verified.identity, trust: { platform: verified.platform, composeHash: verified.composeHash, bindingVerified: true } };
      }
      case "pool_attestation": {
        const nonceValue = hex64(input.nonce);
        const verified = await this.options.verifiedWorker(nonceValue);
        return { platform: verified.platform, reportData: verified.reportData, composeHash: verified.composeHash, bindingVerified: true };
      }
      case "pool_claim_deposit": return this.action(input, { type: "CLAIM_DEPOSIT", depositSecret: text(input.depositSecret, "depositSecret") }, "pool");
      case "pool_get_balance": return this.action(input, { type: "GET_BALANCE" }, "pool-read");
      case "delivery_store": return this.storeDelivery(input);
      case "delivery_get": return this.readDelivery(input);
      case "delivery_submit": return this.action(input, { type: "SUBMIT_DELIVERY", ticketId: text(input.ticketId, "ticketId"), deliveryCommitment: hex64(input.deliveryCommitment) }, "delivery-seller");
      case "delivery_confirm": return this.action(input, { type: "CONFIRM_DELIVERY", ticketId: text(input.ticketId, "ticketId") }, "delivery-buyer");
      case "deal_status": return this.action(input, { type: "GET_DEAL_STATUS", ticketId: text(input.ticketId, "ticketId") }, "pool-read");
      case "deal_cancel": return this.action(input, { type: "REQUEST_CANCELLATION", ticketId: text(input.ticketId, "ticketId") }, "pool");
      case "deal_timeout": return this.action(input, { type: "PROCESS_TIMEOUT", ticketId: text(input.ticketId, "ticketId") }, "pool");
      case "withdrawal_request": {
        const amountAtomic = atomic(input.amountAtomic, "amountAtomic", false);
        return this.action(input, { type: "REQUEST_WITHDRAWAL", recipientId: this.options.accountId, amountAtomic }, "withdrawal", amountAtomic);
      }
      case "token_rotate": return this.rotate(input);
      case "token_revoke": await this.options.api.mutate("POST", "/v1/auth/revoke", requestId(input), {}); return { revoked: true };
    }
  }

  private async createListing(input: Record<string, unknown>) {
    const product = requiredObject(input.product, "product");
    const encryptedProduct = this.encrypt(product, this.boxPublicKey, this.options.boxKeyId, "airotc:listing:v1");
    return this.options.api.mutate("POST", "/v1/listings", requestId(input), {
      kind: enumText(input.kind, ["API_ACCESS", "DIGITAL_ASSET", "SERVICE", "OTHER"]),
      tagHashes: stringList(input.tagHashes),
      sellerEncryptionKeyId: this.options.boxKeyId,
      sellerEncryptionPublicKey: bytesToBase64Url(this.boxPublicKey),
      encryptedProduct,
    });
  }

  private async sendMessage(input: Record<string, unknown>) {
    const ticketRef = text(input.ticketRef, "ticketRef");
    const ticket = await this.options.api.get(`/v1/tickets/${encodeURIComponent(ticketRef)}`) as Record<string, unknown>;
    const payload = { message: text(input.message, "message"), sentAtNs: this.nowNs().toString() };
    return this.options.api.mutate("POST", `/v1/tickets/${encodeURIComponent(ticketRef)}/messages`, requestId(input), {
      buyerEnvelope: this.encrypt(payload, publicBox(ticket.buyerEncryptionPublicKey), text(ticket.buyerEncryptionKeyId, "buyer key ID"), "airotc:ticket-message:v1"),
      sellerEnvelope: this.encrypt(payload, publicBox(ticket.sellerEncryptionPublicKey), text(ticket.sellerEncryptionKeyId, "seller key ID"), "airotc:ticket-message:v1"),
    });
  }

  private async readMessages(input: Record<string, unknown>) {
    const ticketRef = text(input.ticketRef, "ticketRef");
    const response = await this.options.api.get(`/v1/tickets/${encodeURIComponent(ticketRef)}/messages`) as { messages?: unknown[] };
    return { messages: (response.messages ?? []).map((entry) => {
      const message = record(entry);
      const candidate = message.buyerEnvelope && record(message.buyerEnvelope).recipientKeyId === this.options.boxKeyId
        ? message.buyerEnvelope : message.sellerEnvelope;
      return { messageRef: message.messageRef, sequence: message.sequence, senderRole: message.senderRole, payload: this.decrypt(candidate) };
    }) };
  }

  private async submitTerms(input: Record<string, unknown>) {
    const identity = (await this.options.verifiedWorker()).identity as unknown as Record<string, unknown>;
    const signed = signTerms({
      terms: requiredObject(input.terms, "terms") as unknown as FinalTermsV1,
      role: enumText(input.role, ["BUYER", "SELLER"]),
      signerId: this.options.accountId,
      replyKeyId: this.options.boxKeyId,
      replyPublicKey: bytesToBase64Url(this.boxPublicKey),
      submissionNonce: nonce(input.submissionNonce),
      signingSeed: this.options.signingSeed,
    });
    const envelope = this.encrypt(signed, publicBox(identity.encryptionPublicKey), text(identity.encryptionKeyId, "TEE key ID"), "airotc:terms-submission:v1");
    return this.proxyResult(await this.options.api.mutate("POST", `/v1/worker/terms/${String(input.role).toLowerCase()}`, requestId(input), { envelope }));
  }

  private async action(input: Record<string, unknown>, actionValue: WorkerAction, category: "pool" | "pool-read" | "delivery-seller" | "delivery-buyer" | "withdrawal", spendAtomic?: string) {
    const identity = (await this.options.verifiedWorker()).identity as unknown as Record<string, unknown>;
    const signed = signWorkerAction({
      actorId: this.options.accountId,
      publicKey: this.publicKey,
      replyKeyId: this.options.boxKeyId,
      replyPublicKey: bytesToBase64Url(this.boxPublicKey),
      nonce: nonce(input.actionNonce),
      expiresAtNs: atomic(input.expiresAtNs ?? (this.nowNs() + 300_000_000_000n).toString(), "expiresAtNs", false),
      action: actionValue,
      signingSeed: this.options.signingSeed,
    });
    const envelope = this.encrypt(signed, publicBox(identity.encryptionPublicKey), text(identity.encryptionKeyId, "TEE key ID"), "airotc:worker-action:v1");
    return this.proxyResult(await this.options.api.mutate("POST", `/v1/worker/actions/${category}`, requestId(input), { envelope }, spendAtomic));
  }

  private async storeDelivery(input: Record<string, unknown>) {
    const ticketRef = text(input.ticketRef, "ticketRef");
    const payload = requiredObject(input.delivery, "delivery");
    const ticket = await this.options.api.get(`/v1/tickets/${encodeURIComponent(ticketRef)}`) as Record<string, unknown>;
    const deliveryCommitment = domainSeparatedHash("airotc:delivery:v1", utf8(canonicalObjectJson(payload)));
    const buyerEnvelope = this.encrypt(payload, publicBox(ticket.buyerEncryptionPublicKey), text(ticket.buyerEncryptionKeyId, "buyer key ID"), "airotc:delivery:v1");
    const result = await this.options.api.mutate("PUT", `/v1/tickets/${encodeURIComponent(ticketRef)}/delivery`, requestId(input), { deliveryCommitment, buyerEnvelope });
    return { ...(record(result)), deliveryCommitment };
  }

  private async readDelivery(input: Record<string, unknown>) {
    const ticketRef = text(input.ticketRef, "ticketRef");
    const response = await this.options.api.get(`/v1/tickets/${encodeURIComponent(ticketRef)}/delivery`) as Record<string, unknown>;
    if (response.delivery === null) return { delivery: null };
    const delivery = record(response.delivery);
    return { deliveryRef: delivery.deliveryRef, deliveryCommitment: delivery.deliveryCommitment, delivery: this.decrypt(delivery.buyerEnvelope) };
  }

  private async rotate(input: Record<string, unknown>) {
    const response = await this.options.api.mutate("POST", "/v1/auth/rotate", requestId(input), {}) as Record<string, unknown>;
    this.options.api.replaceToken(text(response.token, "rotated token"));
    return { rotated: true, expiresAtNs: response.expiresAtNs, scopes: response.scopes, roles: response.roles };
  }

  private proxyResult(value: unknown): unknown {
    const response = record(value);
    const decrypted = this.decrypt(response.envelope);
    const result = record(decrypted);
    if (result.ok === false) {
      const error = typeof result.error === "object" && result.error !== null ? result.error as Record<string, unknown> : {};
      throw new Error(`${text(error.code ?? "WORKER_REJECTED", "worker error code")}: ${text(error.message ?? "Worker rejected the request", "worker error message")}`);
    }
    return decrypted;
  }

  private encrypt(payload: unknown, recipientPublicKey: Uint8Array, recipientKeyId: string, context: string): EncryptedEnvelopeV1 {
    return encryptJsonForRecipient({ payload, recipientPublicKey, recipientKeyId, context });
  }

  private decrypt(value: unknown): unknown {
    return decryptJsonEnvelope({
      envelope: value as EncryptedEnvelopeV1,
      recipientSecretKey: this.options.boxSecretKey,
      expectedKeyId: this.options.boxKeyId,
      expectedContext: record(value).context as string,
    });
  }
}

function definition(name: typeof TOOL_NAMES[number]): ToolDefinition {
  const descriptions: Record<typeof TOOL_NAMES[number], string> = {
    marketplace_list: "List active encrypted marketplace listings.", marketplace_create: "Create an encrypted listing as a seller.",
    ticket_create: "Open a private negotiation ticket as a buyer.", ticket_list: "List tickets for this wallet.", ticket_get: "Read one ticket.",
    ticket_messages: "Decrypt this wallet's ticket messages.", ticket_send_message: "Encrypt and send a ticket message to both parties.",
    terms_submit: "Sign and encrypt exact structured terms after checking the reusable private pool balance.", pool_identity: "Read the worker encryption identity.",
    pool_attestation: "Read nonce-bound TEE attestation evidence.", pool_claim_deposit: "Add a finalized public deposit to this wallet's reusable private pool balance, preferably before negotiating a deal.",
    pool_get_balance: "Check this wallet's reusable private pool balance before submitting terms or withdrawing.", delivery_store: "Encrypt delivery data for the buyer.",
    delivery_get: "Decrypt delivery data as the buyer.", delivery_submit: "Commit delivered status in the confidential ledger.",
    delivery_confirm: "Confirm delivery as the buyer.", deal_status: "Read a private deal status.", deal_cancel: "Request cancellation.",
    deal_timeout: "Manually request an already-expired timeout; the TEE also processes timeouts automatically.", withdrawal_request: "Request a policy-limited withdrawal.",
    token_rotate: "Rotate this wallet-bound MCP token without returning it to the model.", token_revoke: "Revoke this MCP token.",
  };
  return { name, description: descriptions[name], inputSchema: schemaFor(name) };
}

function schemaFor(name: typeof TOOL_NAMES[number]): Record<string, unknown> {
  const string = { type: "string" };
  const request = { requestId: string };
  const action = { ...request, actionNonce: string, expiresAtNs: { type: "string", pattern: "^[1-9][0-9]*$" } };
  switch (name) {
    case "marketplace_list": return schema([], { tagHash: { type: "string", pattern: "^[0-9a-f]{64}$" } });
    case "marketplace_create": return schema(["requestId", "kind", "tagHashes", "product"], { ...request, kind: { enum: ["API_ACCESS", "DIGITAL_ASSET", "SERVICE", "OTHER"] }, tagHashes: { type: "array", items: string, maxItems: 16 }, product: { type: "object" } });
    case "ticket_create": return schema(["requestId", "listingRef"], { ...request, listingRef: string });
    case "ticket_list":
    case "pool_identity": return schema([], {});
    case "ticket_get":
    case "ticket_messages":
    case "delivery_get": return schema(["ticketRef"], { ticketRef: string });
    case "ticket_send_message": return schema(["requestId", "ticketRef", "message"], { ...request, ticketRef: string, message: string });
    case "terms_submit": return schema(["requestId", "role", "terms"], { ...request, submissionNonce: string, role: { enum: ["BUYER", "SELLER"] }, terms: { type: "object" } });
    case "pool_attestation": return schema(["nonce"], { nonce: { type: "string", pattern: "^[0-9a-f]{64}$" } });
    case "pool_claim_deposit": return schema(["requestId", "actionNonce", "depositSecret"], { ...action, depositSecret: string });
    case "pool_get_balance": return schema(["requestId", "actionNonce"], action);
    case "delivery_store": return schema(["requestId", "ticketRef", "delivery"], { ...request, ticketRef: string, delivery: { type: "object" } });
    case "delivery_submit": return schema(["requestId", "actionNonce", "ticketId", "deliveryCommitment"], { ...action, ticketId: string, deliveryCommitment: { type: "string", pattern: "^[0-9a-f]{64}$" } });
    case "delivery_confirm":
    case "deal_status":
    case "deal_cancel":
    case "deal_timeout": return schema(["requestId", "actionNonce", "ticketId"], { ...action, ticketId: string });
    case "withdrawal_request": return schema(["requestId", "actionNonce", "amountAtomic"], { ...action, amountAtomic: { type: "string", pattern: "^[1-9][0-9]*$" } });
    case "token_rotate":
    case "token_revoke": return schema(["requestId"], request);
  }
}

function schema(required: string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_INPUT: Expected an object"); return value as Record<string, unknown>; }
function requiredObject(value: unknown, field: string): Record<string, unknown> { try { return record(value); } catch { throw new Error(`INVALID_INPUT: ${field} must be an object`); } }
function text(value: unknown, field: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 100_000) throw new Error(`INVALID_INPUT: ${field} is invalid`); return value; }
function nonce(value: unknown): string { const result = value === undefined ? randomBytes(18).toString("base64url") : text(value, "nonce"); if (!/^[A-Za-z0-9_-]{22,128}$/.test(result)) throw new Error("INVALID_INPUT: nonce is invalid"); return result; }
function requestId(input: Record<string, unknown>): string { return nonce(input.requestId); }
function atomic(value: unknown, field: string, zero = true): string { const result = text(value, field); if (!(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(result) || BigInt(result) >= 2n ** 128n) throw new Error(`INVALID_INPUT: ${field} must be an atomic-unit integer string`); return result; }
function hex64(value: unknown): string { const result = text(value, "hash"); if (!/^[0-9a-f]{64}$/.test(result)) throw new Error("INVALID_INPUT: expected a 64-character lowercase hex value"); return result; }
function stringList(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("INVALID_INPUT: expected a string list"); return value as string[]; }
function enumText<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) throw new Error("INVALID_INPUT: unsupported value"); return value as T; }
function publicBox(value: unknown): Uint8Array { const textValue = text(value, "encryption public key"); return Uint8Array.from(Buffer.from(textValue.replace(/-/g, "+").replace(/_/g, "/"), "base64")); }
function query(value: unknown, key: string): string { return value === undefined ? "" : `?${key}=${encodeURIComponent(text(value, key))}`; }
