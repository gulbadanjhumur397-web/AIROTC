import { request } from "node:http";
import {
  isSha256Hex,
  workerAttestationReportData,
} from "@air-otc/shared-types";
import type { AttestationEvidence, AttestationProvider } from "./types.js";

const MAX_DSTACK_RESPONSE_BYTES = 16 * 1024 * 1024;

interface WorkerIdentity {
  workerId: string;
  encryptionKeyId: string;
  encryptionPublicKey: string;
}

interface DstackInfoResponse {
  app_id: string;
  instance_id: string;
  compose_hash: string;
  os_image_hash: string;
}

interface DstackAttestResponse {
  attestation: string;
}

export type DstackGuestCall = (path: string, body: Record<string, unknown>) => Promise<unknown>;

export function attestationReportData(identity: WorkerIdentity, nonce: string): string {
  return workerAttestationReportData(identity, nonce);
}

export class DstackAttestationProvider implements AttestationProvider {
  private readonly call: DstackGuestCall;

  constructor(
    socketPath = "/var/run/dstack.sock",
    call?: DstackGuestCall,
  ) {
    this.call = call ?? ((path, body) => callDstackGuest(socketPath, path, body));
  }

  async getEvidence(reportData: string): Promise<AttestationEvidence> {
    if (!isSha256Hex(reportData)) throw new Error("Attestation report data must be a SHA-256 hash");
    const [rawInfo, rawAttestation] = await Promise.all([
      this.call("/v1/Info", {}),
      this.call("/v1/Attest", { report_data: reportData, include_boottime_gpu_evidence: false }),
    ]);
    const info = requireObject(rawInfo, "dstack info") as unknown as DstackInfoResponse;
    const attestation = requireObject(rawAttestation, "dstack attestation") as unknown as DstackAttestResponse;
    for (const [name, value] of [
      ["app_id", info.app_id],
      ["instance_id", info.instance_id],
      ["compose_hash", info.compose_hash],
      ["os_image_hash", info.os_image_hash],
    ] as const) {
      if (!isNonemptyEvenHex(value)) throw new Error(`Invalid dstack ${name}`);
    }
    if (!isNonemptyEvenHex(attestation.attestation)) throw new Error("Invalid dstack attestation document");
    return {
      version: 1,
      platform: "DSTACK_CVM",
      reportData,
      attestationHex: attestation.attestation,
      appId: info.app_id,
      instanceId: info.instance_id,
      composeHash: requireHash(info.compose_hash, "compose_hash"),
      osImageHash: requireHash(info.os_image_hash, "os_image_hash"),
      issuedAt: new Date().toISOString(),
    };
  }
}

export class DevelopmentAttestationProvider implements AttestationProvider {
  async getEvidence(reportData: string): Promise<AttestationEvidence> {
    if (!isSha256Hex(reportData)) throw new Error("Attestation report data must be a SHA-256 hash");
    return {
      version: 1,
      platform: "DEV_UNVERIFIED",
      reportData,
      attestationHex: "",
      appId: "00",
      instanceId: "00",
      composeHash: "0".repeat(64),
      osImageHash: "0".repeat(64),
      issuedAt: new Date(0).toISOString(),
    };
  }
}

function callDstackGuest(
  socketPath: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": encoded.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DSTACK_RESPONSE_BYTES) {
            response.destroy(new Error("dstack response exceeded the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`dstack guest request failed with status ${response.statusCode ?? 500}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("dstack guest returned invalid JSON"));
          }
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(encoded);
  });
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isNonemptyEvenHex(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}

function requireHash(value: string, name: string): string {
  if (!isSha256Hex(value)) throw new Error(`Invalid dstack ${name}`);
  return value;
}
