import { base64UrlToBytes } from "@air-otc/shared-types";

export interface WorkerConfig {
  host: string;
  port: number;
  workerId: string;
  encryptionKeyId: string;
  encryptionSecretKey: Uint8Array;
  ledgerKey: Uint8Array;
  ledgerPath: string;
  dstackSocketPath: string | null;
  developmentAttestation: boolean;
  nearNetworkId: string;
  nearRpcUrl: string;
  nearAccountId: string;
  nearPrivateKey: string;
  nearContractId: string;
  maintenanceIntervalMs: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(environment: NodeJS.ProcessEnv, name: string): Uint8Array {
  const value = base64UrlToBytes(required(environment, name));
  if (value.length !== 32) throw new Error(`${name} must encode exactly 32 bytes as base64url`);
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const port = Number.parseInt(environment.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
  const maintenanceIntervalMs = Number.parseInt(environment.TEE_MAINTENANCE_INTERVAL_MS ?? "15000", 10);
  if (!Number.isInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 1_000 || maintenanceIntervalMs > 300_000) {
    throw new Error("TEE_MAINTENANCE_INTERVAL_MS must be between 1000 and 300000");
  }
  const developmentAttestation = environment.ALLOW_UNVERIFIED_DEV_ATTESTATION === "true";
  if (environment.NODE_ENV === "production" && developmentAttestation) {
    throw new Error("Unverified development attestation is forbidden in production");
  }
  const dstackSocketPath = developmentAttestation ? null : environment.DSTACK_SOCKET_PATH ?? "/var/run/dstack.sock";
  return {
    host: environment.HOST ?? "127.0.0.1",
    port,
    workerId: required(environment, "TEE_NEAR_ACCOUNT_ID"),
    encryptionKeyId: required(environment, "TEE_ENCRYPTION_KEY_ID"),
    encryptionSecretKey: secret(environment, "TEE_BOX_SECRET_KEY_B64URL"),
    ledgerKey: secret(environment, "TEE_LEDGER_KEY_B64URL"),
    ledgerPath: environment.TEE_LEDGER_PATH ?? "/var/lib/airotc/ledger.snapshot",
    dstackSocketPath,
    developmentAttestation,
    nearNetworkId: environment.NEAR_NETWORK_ID ?? "testnet",
    nearRpcUrl: environment.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
    nearAccountId: required(environment, "TEE_NEAR_ACCOUNT_ID"),
    nearPrivateKey: required(environment, "TEE_NEAR_PRIVATE_KEY"),
    nearContractId: required(environment, "NEAR_POOL_CONTRACT_ID"),
    maintenanceIntervalMs,
  };
}

