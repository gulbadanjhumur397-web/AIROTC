import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  verifyWorkerAttestationBinding,
  workerEncryptionKeyHash,
} from "../shared-types/dist/index.js";

const workerEvidencePath = resolve(process.env.PHALA_WORKER_ATTESTATION_FILE ?? "evidence/phala-worker-attestation.json");
const platformEvidencePath = resolve(process.env.PHALA_CVM_ATTESTATION_FILE ?? "evidence/phala-cvm-attestation.json");
const workerQuotePath = resolve(process.env.PHALA_WORKER_QUOTE_VERIFICATION_FILE ?? "evidence/phala-worker-quote-verification.json");
const platformQuotePath = resolve(process.env.PHALA_PLATFORM_QUOTE_VERIFICATION_FILE ?? "evidence/phala-platform-quote-verification.json");
const summaryPath = resolve(process.env.PHALA_VERIFICATION_SUMMARY_FILE ?? "evidence/phala-verification-summary.json");

const expected = {
  workerId: required("TEE_NEAR_ACCOUNT_ID"),
  encryptionKeyHash: requireHash(required("TEE_ENCRYPTION_KEY_HASH"), "TEE_ENCRYPTION_KEY_HASH"),
  composeHash: requireHash(required("TEE_MEASUREMENT_HASH"), "TEE_MEASUREMENT_HASH"),
  image: required("TEE_WORKER_IMAGE"),
  appId: requireEvenHex(required("PHALA_APP_ID"), "PHALA_APP_ID"),
  instanceId: requireEvenHex(required("PHALA_INSTANCE_ID"), "PHALA_INSTANCE_ID"),
  osImageHash: requireHash(required("PHALA_OS_IMAGE_HASH"), "PHALA_OS_IMAGE_HASH"),
};
if (!/@sha256:[0-9a-f]{64}$/.test(expected.image)) {
  throw new Error("TEE_WORKER_IMAGE must use an immutable SHA-256 digest");
}

const [worker, platform, workerQuote, platformQuote] = await Promise.all([
  readJson(workerEvidencePath),
  readJson(platformEvidencePath),
  readJson(workerQuotePath),
  readJson(platformQuotePath),
]);

const nonce = requireHash(worker?.binding?.nonce, "worker attestation nonce");
const verifiedBinding = verifyWorkerAttestationBinding(worker, nonce, {
  workerId: expected.workerId,
  encryptionKeyHash: expected.encryptionKeyHash,
  composeHash: expected.composeHash,
});
assert(workerEncryptionKeyHash(worker.identity) === expected.encryptionKeyHash, "Worker encryption-key hash mismatch");
assert(worker.evidence.appId === expected.appId, "Worker attestation app ID mismatch");
assert(worker.evidence.instanceId === expected.instanceId, "Worker attestation instance ID mismatch");
assert(worker.evidence.osImageHash === expected.osImageHash, "Worker attestation OS image hash mismatch");

assert(platform.success === true, "Phala platform attestation was not successful");
assert(platform.is_online === true, "Phala platform attestation reports the CVM offline");
assert(platform.is_public === true, "Phala platform attestation is not publicly verifiable");
assert(platform.error == null, "Phala platform attestation contains an error");
assert(typeof platform.compose_file === "string", "Phala platform compose file is missing");
assert(platform.tcb_info?.app_compose === platform.compose_file, "Attested compose and returned compose differ");
assert(sha256(platform.compose_file) === expected.composeHash, "Attested compose hash mismatch");

const appCompose = JSON.parse(platform.compose_file);
assert(typeof appCompose.docker_compose_file === "string", "Attested Docker Compose file is missing");
assert(appCompose.docker_compose_file.includes(`image: ${expected.image}`), "Attested Docker image digest mismatch");
assert(appCompose.docker_compose_file.includes("/var/run/dstack.sock:/var/run/dstack.sock"), "Attested dstack socket mount is missing");
assert(appCompose.docker_compose_file.includes("ALLOW_UNVERIFIED_DEV_ATTESTATION: \"false\""), "Development attestation is not disabled");

const events = platform.tcb_info?.event_log;
assert(Array.isArray(events) && events.length > 0, "Phala event log is missing");
for (let index = 0; index < 4; index += 1) {
  const measured = replayRtmr(events, index);
  assert(measured === platform.tcb_info[`rtmr${index}`], `RTMR${index} event-log replay mismatch`);
}
assert(events.some((entry) => entry?.event === "compose-hash" && entry?.event_payload === expected.composeHash), "Compose-hash event is missing");

verifyQuoteResult(workerQuote, "worker");
verifyQuoteResult(platformQuote, "platform");
const workerQuoteBody = workerQuote.quote.body;
const platformQuoteBody = platformQuote.quote.body;
const expectedReportData = `0x${verifiedBinding.reportData}${"0".repeat(64)}`;
assert(workerQuoteBody.reportdata === expectedReportData, "Verified TDX quote is not bound to the worker report data");

for (const measurement of ["mrtd", "rtmr0", "rtmr1", "rtmr2", "rtmr3"]) {
  const expectedMeasurement = `0x${platform.tcb_info[measurement]}`;
  assert(workerQuoteBody[measurement] === expectedMeasurement, `Worker quote ${measurement} mismatch`);
  assert(platformQuoteBody[measurement] === expectedMeasurement, `Platform quote ${measurement} mismatch`);
}

const attestationBytes = Buffer.from(worker.evidence.attestationHex, "hex");
assert(attestationBytes.length > 4, "Worker attestation document is empty");
assert(attestationBytes.subarray(4, 6).toString("hex") === "0400", "Worker attestation does not contain a TDX v4 quote");
const platformQuoteHex = platform.app_certificates?.[0]?.quote;
requireEvenHex(platformQuoteHex, "platform certificate quote");

const summary = {
  generatedAt: new Date().toISOString(),
  verified: true,
  platform: "Phala Cloud dstack Intel TDX",
  workerId: expected.workerId,
  appId: expected.appId,
  instanceId: expected.instanceId,
  composeHash: expected.composeHash,
  osImageHash: expected.osImageHash,
  image: expected.image,
  encryptionKeyHash: expected.encryptionKeyHash,
  reportData: verifiedBinding.reportData,
  workerQuoteId: workerQuote.id,
  platformQuoteId: platformQuote.id,
  workerQuoteSha256: sha256(attestationBytes.subarray(4)),
  platformQuoteSha256: sha256(Buffer.from(platformQuoteHex, "hex")),
  checks: {
    nonceBoundWorkerIdentity: true,
    workerQuoteVerified: true,
    platformQuoteVerified: true,
    proofOfCloud: true,
    eventLogReplayed: true,
    composeHashBound: true,
    imageDigestBound: true,
    productionOsBound: true,
  },
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function verifyQuoteResult(result, name) {
  assert(result?.success === true, `${name} quote verification failed`);
  assert(result?.proof_of_cloud === true, `${name} quote is not proof-of-cloud verified`);
  assert(result?.quote?.verified === true, `${name} TDX quote signature is not verified`);
  assert(result.quote.header?.version === 4, `${name} quote is not TDX quote version 4`);
  assert(result.quote.header?.tee_type === "TEE_TDX", `${name} quote is not Intel TDX`);
}

function replayRtmr(events, index) {
  let current = Buffer.alloc(48);
  for (const event of events) {
    if (event?.imr !== index) continue;
    const digest = Buffer.from(requireHash384(event.digest, `RTMR${index} event digest`), "hex");
    current = createHash("sha384").update(current).update(digest).digest();
  }
  return current.toString("hex");
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireHash(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256 hex value`);
  return value;
}

function requireHash384(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{96}$/.test(value)) throw new Error(`${name} must be a SHA-384 hex value`);
  return value;
}

function requireEvenHex(value, name) {
  if (typeof value !== "string" || value.length < 2 || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${name} must be nonempty lowercase hex`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
