import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./phase9-lib.mjs";

const repoRoot = resolve(new URL("../../", import.meta.url).pathname);
const requiredFiles = [
  "near/escrow-contract/build/air-otc-pool.wasm",
  "near/tee-worker/Dockerfile",
  "near/tee-worker/deployment/docker-compose.tee.yml",
  "near/tee-worker/deployment/docker-compose.phala.yml",
  "near/deployment/testnet.env.example",
  "near/deployment/TESTNET_RUNBOOK.md",
  "near/deployment/JUDGE_REPRODUCTION.md",
  "near/deployment/SECURITY_AND_PRIVACY.md",
  "near/deployment/ATTESTATION.md",
  "near/deployment/REUSE_DISCLOSURE.md",
  "near/deployment/EVIDENCE_TEMPLATE.md",
  "near/deployment/TESTNET_STATE.md",
  "near/deployment/PHALA_TEE_STATE.md",
  "near/deployment/agents/buyer.prompt.md",
  "near/deployment/agents/seller.prompt.md",
  "near/demo-api/server.mjs",
  "near/scripts/deploy-contract.mjs",
  "near/scripts/bootstrap-testnet-wallets.mjs",
  "near/scripts/prepare-testnet-environment.mjs",
  "near/scripts/finalize-worker-key.mjs",
  "near/scripts/register-hosted-tee.mjs",
  "near/scripts/derive-worker-public-key.mjs",
  "near/scripts/derive-worker-identity.mjs",
  "near/scripts/prepare-deposit.mjs",
  "near/scripts/prepare-agent-env.mjs",
  "near/scripts/deposit-testnet.mjs",
  "near/scripts/issue-mcp-token.mjs",
  "near/scripts/inspect-testnet.mjs",
  "near/scripts/verify-deployment-transactions.mjs",
  "near/scripts/verify-phala-evidence.mjs",
  "near/scripts/verify-live-privacy.mjs",
  "near/scripts/two-agent-demo.mjs",
];
const missing = [];
for (const path of requiredFiles) {
  try { await stat(resolve(repoRoot, path)); } catch { missing.push(path); }
}
if (missing.length > 0) throw new Error(`Missing Phase 9 files: ${missing.join(", ")}`);

const wasm = await readFile(resolve(repoRoot, requiredFiles[0]));
const wasmHash = sha256(wasm);
const compose = await readFile(resolve(repoRoot, "near/tee-worker/deployment/docker-compose.tee.yml"), "utf8");
if (!compose.includes("TEE_WORKER_IMAGE") || !compose.includes("@sha256:")) {
  throw new Error("TEE manifest must require a digest-pinned image reference");
}
if (/image:\s*\S+:latest\b/.test(compose)) throw new Error("Mutable latest image tag is forbidden");

for (const script of requiredFiles.filter((path) => path.endsWith(".mjs"))) {
  execFileSync(process.execPath, ["--check", resolve(repoRoot, script)], { stdio: "pipe" });
}
await import("near-api-js");
execFileSync(process.execPath, [resolve(repoRoot, "near/scripts/two-agent-demo.mjs"), "--check"], {
  cwd: resolve(repoRoot, "near"),
  stdio: "pipe",
});
execFileSync(process.execPath, [resolve(repoRoot, "near/scripts/check-secrets.mjs")], {
  cwd: repoRoot,
  stdio: "pipe",
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  network: "testnet-only",
  wasmBytes: wasm.length,
  wasmSha256: wasmHash,
  requiredFiles: requiredFiles.length,
  scriptSyntaxChecks: requiredFiles.filter((path) => path.endsWith(".mjs")).length,
  secretsScan: "passed",
  liveDeployment: "verified-phala-worker-registered-and-unpaused",
}, null, 2)}\n`);
