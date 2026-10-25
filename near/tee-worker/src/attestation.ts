import { DstackClient } from "@phala/dstack-sdk";
import {
  isSha256Hex,
  workerAttestationReportData,
} from "@air-otc/shared-types";
import type { AttestationEvidence, AttestationProvider } from "./types.js";

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

export interface DstackGuestClient {
  info(): Promise<unknown>;
  attest(reportData: string | Buffer | Uint8Array): Promise<unknown>;
}

export function attestationReportData(identity: WorkerIdentity, nonce: string): string {
  return workerAttestationReportData(identity, nonce);
}

export class DstackAttestationProvider implements AttestationProvider {
  private readonly client: DstackGuestClient;

  constructor(
    socketPath = "/var/run/dstack.sock",
    client?: DstackGuestClient,
  ) {
    this.client = client ?? new DstackClient(socketPath);
  }

  async getEvidence(reportData: string): Promise<AttestationEvidence> {
    if (!isSha256Hex(reportData)) throw new Error("Attestation report data must be a SHA-256 hash");
    const [rawInfo, rawAttestation] = await Promise.all([
      this.client.info(),
      this.client.attest(Buffer.from(reportData, "hex")),
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
