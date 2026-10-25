import { canonicalObjectJson, utf8 } from "./encoding.js";
import { domainSeparatedHash, isSha256Hex } from "./hash.js";

export interface WorkerIdentityV1 {
  workerId: string;
  encryptionKeyId: string;
  encryptionPublicKey: string;
}

export interface WorkerAttestationEvidenceV1 {
  version: 1;
  platform: "DSTACK_CVM" | "DEV_UNVERIFIED";
  reportData: string;
  attestationHex: string;
  appId: string;
  instanceId: string;
  composeHash: string;
  osImageHash: string;
  issuedAt: string;
}

export interface WorkerAttestationResponseV1 {
  identity: WorkerIdentityV1;
  binding: { version: 1; nonce: string; reportData: string };
  evidence: WorkerAttestationEvidenceV1;
}

export interface WorkerTrustPolicyV1 {
  workerId: string;
  encryptionKeyHash: string;
  composeHash: string;
  allowDevelopment?: boolean;
}

export interface VerifiedWorkerBinding {
  identity: WorkerIdentityV1;
  platform: WorkerAttestationEvidenceV1["platform"];
  reportData: string;
  composeHash: string;
}

export function workerAttestationReportData(identity: WorkerIdentityV1, nonce: string): string {
  if (!isSha256Hex(nonce)) throw new Error("Attestation nonce must be 32 lowercase-hex bytes");
  return domainSeparatedHash(
    "airotc:tee-identity-attestation:v1",
    utf8(canonicalObjectJson({
      version: 1,
      nonce,
      workerId: requireIdentityText(identity.workerId, "workerId"),
      encryptionKeyId: requireIdentityText(identity.encryptionKeyId, "encryptionKeyId"),
      encryptionPublicKey: requireBase64UrlKey(identity.encryptionPublicKey),
    })),
  );
}

export function workerEncryptionKeyHash(identity: WorkerIdentityV1): string {
  return domainSeparatedHash(
    "airotc:tee-encryption-identity:v1",
    utf8(canonicalObjectJson({
      workerId: requireIdentityText(identity.workerId, "workerId"),
      encryptionKeyId: requireIdentityText(identity.encryptionKeyId, "encryptionKeyId"),
      encryptionPublicKey: requireBase64UrlKey(identity.encryptionPublicKey),
    })),
  );
}

export function verifyWorkerAttestationBinding(
  value: unknown,
  nonce: string,
  policy: WorkerTrustPolicyV1,
): VerifiedWorkerBinding {
  if (!isSha256Hex(nonce)) throw new Error("Attestation nonce must be a SHA-256 hex value");
  if (!isSha256Hex(policy.encryptionKeyHash)) throw new Error("Trusted encryption key hash is invalid");
  if (!isSha256Hex(policy.composeHash)) throw new Error("Trusted compose hash is invalid");

  const response = requireObject(value, "worker attestation") as unknown as WorkerAttestationResponseV1;
  const identity = requireObject(response.identity, "worker identity") as unknown as WorkerIdentityV1;
  const binding = requireObject(response.binding, "attestation binding") as unknown as WorkerAttestationResponseV1["binding"];
  const evidence = requireObject(response.evidence, "attestation evidence") as unknown as WorkerAttestationEvidenceV1;

  if (identity.workerId !== policy.workerId) throw new Error("Worker account is not the on-chain approved worker");
  if (workerEncryptionKeyHash(identity) !== policy.encryptionKeyHash) {
    throw new Error("Worker encryption identity is not the on-chain approved identity");
  }
  if (binding.version !== 1 || binding.nonce !== nonce) throw new Error("Attestation nonce binding is invalid");
  const reportData = workerAttestationReportData(identity, nonce);
  if (binding.reportData !== reportData || evidence.reportData !== reportData) {
    throw new Error("Attestation report data does not bind the approved worker identity");
  }
  if (evidence.version !== 1) throw new Error("Attestation evidence version is unsupported");
  if (evidence.platform === "DEV_UNVERIFIED") {
    if (policy.allowDevelopment !== true) throw new Error("Unverified development attestation is forbidden");
  } else if (evidence.platform === "DSTACK_CVM") {
    if (!isNonemptyEvenHex(evidence.attestationHex)) throw new Error("Dstack attestation document is invalid");
  } else {
    throw new Error("Attestation platform is unsupported");
  }
  if (evidence.composeHash !== policy.composeHash) throw new Error("Attested compose hash is not approved on-chain");
  if (!isSha256Hex(evidence.composeHash) || !isSha256Hex(evidence.osImageHash)) {
    throw new Error("Attestation measurement is invalid");
  }
  if (!isNonemptyEvenHex(evidence.appId) || !isNonemptyEvenHex(evidence.instanceId)) {
    throw new Error("Attestation instance identity is invalid");
  }
  return { identity: { ...identity }, platform: evidence.platform, reportData, composeHash: evidence.composeHash };
}

export async function fetchNearPoolWorkerPolicy(input: {
  rpcUrl: string;
  contractId: string;
  fetcher?: typeof fetch;
  allowDevelopment?: boolean;
}): Promise<WorkerTrustPolicyV1> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(input.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "airotc-worker-policy",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: input.contractId,
        method_name: "get_config",
        args_base64: "e30=",
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("NEAR pool trust-policy query failed");
  const rpc = await response.json() as { result?: { result?: number[] }; error?: unknown };
  if (rpc.error || !Array.isArray(rpc.result?.result)) throw new Error("NEAR pool trust-policy response is invalid");
  const config = JSON.parse(new TextDecoder().decode(Uint8Array.from(rpc.result.result))) as Record<string, unknown>;
  if (config.paused === true) throw new Error("NEAR private pool is paused");
  return {
    workerId: requireIdentityText(config.tee_worker_id, "tee_worker_id"),
    encryptionKeyHash: requireHash(config.tee_encryption_key_hash, "tee_encryption_key_hash"),
    composeHash: requireHash(config.tee_measurement_hash, "tee_measurement_hash"),
    ...(input.allowDevelopment === true ? { allowDevelopment: true } : {}),
  };
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireIdentityText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireBase64UrlKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("encryptionPublicKey is invalid");
  return value;
}

function requireHash(value: unknown, name: string): string {
  if (!isSha256Hex(value)) throw new Error(`${name} is invalid`);
  return value;
}

function isNonemptyEvenHex(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}
