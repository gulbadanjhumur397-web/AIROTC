import { base64UrlToBytes } from "@air-otc/shared-types";
import { PrivacyApiClient } from "./api-client.js";
import { McpStdioServer } from "./server.js";
import { AgentTools } from "./tools.js";
import { nearPoolPolicyProvider, WorkerTrustVerifier } from "./worker-trust.js";

const api = new PrivacyApiClient(
  required("PRIVACY_API_URL").replace(/\/$/, ""),
  required("AIROTC_MCP_TOKEN"),
  fetch,
  timeoutMs("PRIVACY_API_REQUEST_TIMEOUT_MS", 90_000),
);
const trust = new WorkerTrustVerifier(api, nearPoolPolicyProvider({
  rpcUrl: required("NEAR_RPC_URL"),
  contractId: required("NEAR_POOL_CONTRACT_ID"),
  allowDevelopment: process.env.ALLOW_UNVERIFIED_DEV_ATTESTATION === "true",
}));
const tools = new AgentTools({
  api,
  accountId: required("AIROTC_ACCOUNT_ID"),
  signingSeed: base64UrlToBytes(required("AIROTC_SIGNING_SEED_B64URL")),
  boxSecretKey: base64UrlToBytes(required("AIROTC_BOX_SECRET_B64URL")),
  boxKeyId: required("AIROTC_BOX_KEY_ID"),
  verifiedWorker: () => trust.verify(),
});
new McpStdioServer(tools).start();

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function timeoutMs(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) throw new Error(`${name} is invalid`);
  return parsed;
}

export * from "./api-client.js";
export * from "./tools.js";
export * from "./server.js";
export * from "./worker-trust.js";
