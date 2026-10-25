import { base64UrlToBytes } from "@air-otc/shared-types";
import { EncryptedFileDatabase } from "./store.js";
import { createPrivacyApiServer } from "./server.js";
import { HttpWorkerProxy, PrivacyApiService } from "./service.js";
import { NearRpcIdentityVerifier, SystemClock, TokenService } from "./token-service.js";

const databaseKey = base64UrlToBytes(required("PRIVACY_API_DATABASE_KEY_B64URL"));
const handleSecret = base64UrlToBytes(required("PRIVACY_API_HANDLE_SECRET_B64URL"));
const clock = new SystemClock();
const service = new PrivacyApiService(
  new EncryptedFileDatabase(process.env.PRIVACY_API_DATABASE_PATH ?? "/var/lib/airotc/privacy-api.db", databaseKey),
  new TokenService(
    new NearRpcIdentityVerifier(process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org"),
    clock,
    handleSecret,
  ),
  new HttpWorkerProxy((process.env.TEE_WORKER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "")),
  clock,
);
await service.initialize();
const server = createPrivacyApiServer(service, {
  allowedOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
});
const port = Number.parseInt(process.env.PORT ?? "8090", 10);
const host = process.env.HOST ?? "127.0.0.1";
server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ level: "info", event: "privacy_api_listening", host, port })}\n`));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export * from "./types.js";
export * from "./store.js";
export * from "./token-service.js";
export * from "./service.js";
export * from "./server.js";
