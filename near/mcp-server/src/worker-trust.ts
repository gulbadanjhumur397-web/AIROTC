import { randomBytes } from "node:crypto";
import {
  fetchNearPoolWorkerPolicy,
  verifyWorkerAttestationBinding,
  type VerifiedWorkerBinding,
  type WorkerTrustPolicyV1,
} from "@air-otc/shared-types";
import type { PrivacyApiClient } from "./api-client.js";

export type WorkerPolicyProvider = () => Promise<WorkerTrustPolicyV1>;
export type VerifiedWorkerProvider = (nonce?: string) => Promise<VerifiedWorkerBinding>;

export function nearPoolPolicyProvider(input: {
  rpcUrl: string;
  contractId: string;
  fetcher?: typeof fetch;
  allowDevelopment?: boolean;
}): WorkerPolicyProvider {
  return () => fetchNearPoolWorkerPolicy(input);
}

export class WorkerTrustVerifier {
  constructor(
    private readonly api: PrivacyApiClient,
    private readonly policy: WorkerPolicyProvider,
  ) {}

  async verify(requestNonce?: string): Promise<VerifiedWorkerBinding> {
    const nonce = requestNonce ?? randomBytes(32).toString("hex");
    const [attestation, policy] = await Promise.all([
      this.api.get(`/v1/worker/attestation?nonce=${nonce}`),
      this.policy(),
    ]);
    return verifyWorkerAttestationBinding(attestation, nonce, policy);
  }
}
