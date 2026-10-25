import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { EncryptedEnvelopeV1 } from "@air-otc/shared-types";
import { asWorkerError } from "./errors.js";
import type { AttestationProvider } from "./types.js";
import { attestationReportData } from "./attestation.js";
import type { ConfidentialWorker } from "./worker.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface WorkerRequestLog {
  event: "worker_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type WorkerRequestLogger = (entry: WorkerRequestLog) => void;

const defaultLogger: WorkerRequestLogger = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export function createWorkerServer(
  worker: ConfidentialWorker,
  attestation: AttestationProvider,
  logger: WorkerRequestLogger = defaultLogger,
): Server {
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const requestUrl = new URL(request.url ?? "/", "http://worker.invalid");
    response.once("finish", () => {
      logger({
        event: "worker_request",
        requestId,
        method: request.method ?? "UNKNOWN",
        path: requestUrl.pathname,
        status: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    });
    setSecurityHeaders(response);
    try {
      const url = requestUrl;
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, service: "air-otc-confidential-worker", version: 1 });
      }
      if (request.method === "GET" && url.pathname === "/v1/identity") {
        return json(response, 200, { ...worker.identity(), attestationEndpoint: "/v1/attestation?nonce=<64-hex>" });
      }
      if (request.method === "GET" && url.pathname === "/v1/attestation") {
        const nonce = url.searchParams.get("nonce") ?? "";
        const identity = worker.identity();
        const reportData = attestationReportData(identity, nonce);
        return json(response, 200, {
          identity,
          binding: { version: 1, nonce, reportData },
          evidence: await attestation.getEvidence(reportData),
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/terms") {
        const body = await readJson(request);
        return json(response, 200, { envelope: await worker.handleTermsEnvelope(requireEnvelope(body)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/actions") {
        const body = await readJson(request);
        return json(response, 200, { envelope: await worker.handleActionEnvelope(requireEnvelope(body), withdrawalCommitment(body)) });
      }
      return json(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      const workerError = asWorkerError(error);
      return json(response, workerError.status, {
        error: { code: workerError.code, message: workerError.status >= 500 ? "Worker request failed" : workerError.message },
      });
    }
  });
}

function withdrawalCommitment(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const commitment = (value as Record<string, unknown>).withdrawalAmountCommitment;
  if (commitment === undefined) return undefined;
  if (typeof commitment !== "string" || !/^[0-9a-f]{64}$/.test(commitment)) throw new Error("Withdrawal amount commitment is invalid");
  return commitment;
}

function requireEnvelope(value: unknown): EncryptedEnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Request body must be an object");
  const envelope = (value as Record<string, unknown>).envelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("Request envelope is required");
  }
  return envelope as EncryptedEnvelopeV1;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

