import { attestationReportData, DevelopmentAttestationProvider, DstackAttestationProvider } from "./attestation.js";
import { loadConfig } from "./config.js";
import { NearContractGateway } from "./contract-gateway.js";
import { NearRpcIdentityVerifier } from "./identity.js";
import { createWorkerServer } from "./server.js";
import { EncryptedFileStateStore } from "./snapshot-store.js";
import { ConfidentialWorker, SystemClock } from "./worker.js";

const config = loadConfig();
const contract = await NearContractGateway.connect({
  networkId: config.nearNetworkId,
  rpcUrl: config.nearRpcUrl,
  accountId: config.nearAccountId,
  privateKey: config.nearPrivateKey,
  contractId: config.nearContractId,
});
const worker = new ConfidentialWorker({
  workerId: config.workerId,
  encryptionKeyId: config.encryptionKeyId,
  encryptionSecretKey: config.encryptionSecretKey,
  stateStore: new EncryptedFileStateStore(config.ledgerPath, config.ledgerKey),
  contract,
  identityVerifier: new NearRpcIdentityVerifier(config.nearRpcUrl, config.nearContractId),
  clock: new SystemClock(),
  anchorMode: "BATCHED",
});
await worker.initialize();
const attestation = config.developmentAttestation
  ? new DevelopmentAttestationProvider()
  : new DstackAttestationProvider(config.dstackSocketPath ?? "/var/run/dstack.sock");
await attestation.getEvidence(attestationReportData(worker.identity(), "0".repeat(64)));

const server = createWorkerServer(worker, attestation);
let maintenanceRunning = false;
const maintenanceTimer = setInterval(() => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  void worker.runMaintenance()
    .catch(() => {
      process.stderr.write(`${JSON.stringify({ level: "error", event: "maintenance_failed" })}\n`);
    })
    .finally(() => {
      maintenanceRunning = false;
    });
}, config.maintenanceIntervalMs);
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", event: "worker_listening", host: config.host, port: config.port })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(maintenanceTimer);
    server.close((error) => {
      if (error) {
        process.stderr.write(`${JSON.stringify({ level: "error", event: "shutdown_failed" })}\n`);
        process.exitCode = 1;
      }
    });
  });
}

