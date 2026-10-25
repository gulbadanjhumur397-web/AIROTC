import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ApiError, PrivacyApiService } from "./service.js";
import { TokenAuthorizationError } from "./token-service.js";
import type { Scope } from "./types.js";

const MAX_BODY = 512 * 1024;

export interface AuditEvent {
  event: "privacy_api_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export function createPrivacyApiServer(
  service: PrivacyApiService,
  options: { maxRequestsPerMinute?: number; logger?: (event: AuditEvent) => void; allowedOrigin?: string } = {},
): Server {
  const logger = options.logger ?? ((event: AuditEvent) => process.stdout.write(`${JSON.stringify(event)}\n`));
  const rateLimit = new FixedWindowRateLimiter(options.maxRequestsPerMinute ?? 120);
  return createServer(async (request, response) => {
    const started = performance.now();
    const auditId = randomUUID();
    const url = new URL(request.url ?? "/", "http://privacy-api.invalid");
    response.once("finish", () => logger({
      event: "privacy_api_request",
      requestId: auditId,
      method: request.method ?? "UNKNOWN",
      path: url.pathname,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    }));
    secure(response, request, options.allowedOrigin);
    try {
      if (request.method === "OPTIONS") return json(response, 204, null);
      const key = request.socket.remoteAddress ?? "unknown";
      if (!rateLimit.allow(key, Date.now())) throw new ApiError("RATE_LIMITED", "Too many requests", 429);
      await route(service, request, response, url);
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : error instanceof TokenAuthorizationError
          ? new ApiError("FORBIDDEN", error.message, 403)
          : new ApiError("INVALID_REQUEST", error instanceof Error ? error.message : "Request failed", 400);
      json(response, apiError.status, { error: { code: apiError.code, message: apiError.status >= 500 ? "Request failed" : apiError.message } });
    }
  });
}

async function route(service: PrivacyApiService, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, service: "air-otc-near-privacy-api", version: 1 });
  if (method === "POST" && url.pathname === "/v1/auth/challenge") return json(response, 201, service.createTokenChallenge(await body(request)));
  if (method === "POST" && url.pathname === "/v1/auth/token") return json(response, 201, await service.issueToken(await body(request) as never));
  if (method === "GET" && url.pathname === "/v1/worker/identity") return json(response, 200, await service.workerIdentity());
  if (method === "GET" && url.pathname === "/v1/worker/attestation") return json(response, 200, await service.workerAttestation(url.searchParams.get("nonce") ?? ""));

  const auth = service.authenticate(bearer(request));
  const requestId = request.headers["x-airotc-request-id"];
  const mutationId = typeof requestId === "string" ? requestId : "";

  if (method === "POST" && url.pathname === "/v1/auth/rotate") return json(response, 201, await service.rotateToken(auth, mutationId));
  if (method === "POST" && url.pathname === "/v1/auth/revoke") return json(response, 200, await service.revokeToken(auth, mutationId));
  if (method === "POST" && url.pathname === "/v1/listings") return json(response, 201, await service.createListing(auth, mutationId, await body(request)));
  if (method === "GET" && url.pathname === "/v1/listings") {
    const tagHash = url.searchParams.get("tagHash");
    return json(response, 200, { listings: service.listListings(auth, tagHash === null ? undefined : tagHash) });
  }
  if (method === "POST" && url.pathname === "/v1/tickets") return json(response, 201, await service.createTicket(auth, mutationId, await body(request)));
  if (method === "GET" && url.pathname === "/v1/tickets") return json(response, 200, { tickets: service.listTickets(auth) });
  const termsRole = /^\/v1\/worker\/terms\/(buyer|seller)$/.exec(url.pathname)?.[1];
  if (method === "POST" && termsRole) return json(response, 200, await service.submitTerms(auth, mutationId, termsRole.toUpperCase() as "BUYER" | "SELLER", await body(request)));

  const actionScope = actionRoute(url.pathname);
  if (method === "POST" && actionScope) {
    const spendHeader = request.headers["x-airotc-spend-atomic"];
    return json(response, 200, await service.submitAction(
      auth,
      mutationId,
      actionScope,
      await body(request),
      typeof spendHeader === "string" ? spendHeader : undefined,
      actionRole(url.pathname),
    ));
  }

  const ticketMatch = /^\/v1\/tickets\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (method === "GET" && ticketMatch?.[1]) return json(response, 200, service.getTicket(auth, ticketMatch[1]));
  const messagesMatch = /^\/v1\/tickets\/([A-Za-z0-9_-]+)\/messages$/.exec(url.pathname);
  if (messagesMatch?.[1] && method === "GET") return json(response, 200, { messages: service.listMessages(auth, messagesMatch[1]) });
  if (messagesMatch?.[1] && method === "POST") return json(response, 201, await service.addMessage(auth, mutationId, messagesMatch[1], await body(request)));
  const deliveryMatch = /^\/v1\/tickets\/([A-Za-z0-9_-]+)\/delivery$/.exec(url.pathname);
  if (deliveryMatch?.[1] && method === "GET") return json(response, 200, { delivery: service.getDelivery(auth, deliveryMatch[1]) });
  if (deliveryMatch?.[1] && method === "PUT") return json(response, 201, await service.putDelivery(auth, mutationId, deliveryMatch[1], await body(request)));
  throw new ApiError("NOT_FOUND", "Route not found", 404);
}

function actionRoute(path: string): Scope | null {
  switch (path) {
    case "/v1/worker/actions/pool": return "pool:write";
    case "/v1/worker/actions/pool-read": return "pool:read";
    case "/v1/worker/actions/delivery-seller": return "delivery:write";
    case "/v1/worker/actions/delivery-buyer": return "delivery:write";
    case "/v1/worker/actions/withdrawal": return "withdrawals:write";
    default: return null;
  }
}

function actionRole(path: string): "BUYER" | "SELLER" | undefined {
  if (path === "/v1/worker/actions/delivery-seller") return "SELLER";
  if (path === "/v1/worker/actions/delivery-buyer") return "BUYER";
  return undefined;
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY) throw new ApiError("BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_JSON", "Request body must be JSON", 400);
  }
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization ?? "";
  if (!value.startsWith("Bearer ")) throw new ApiError("UNAUTHORIZED", "Bearer MCP token is required", 401);
  return value.slice(7).trim();
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

function secure(response: ServerResponse, request: IncomingMessage, allowedOrigin?: string): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  if (allowedOrigin !== undefined && request.headers.origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization,content-type,x-airotc-request-id,x-airotc-spend-atomic");
    response.setHeader("vary", "origin");
  }
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Rate limit maximum must be positive");
  }
  allow(key: string, nowMs: number): boolean {
    const existing = this.buckets.get(key);
    if (!existing || nowMs - existing.startedAt >= 60_000) {
      this.buckets.set(key, { startedAt: nowMs, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.maximum;
  }
}

