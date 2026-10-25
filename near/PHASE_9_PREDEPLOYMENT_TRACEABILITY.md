# Phase 9 predeployment traceability

This comparison covers every Phase 9 item that can be completed before the hosting
platform is supplied. Testnet accounts and a paused pool deployment now exist. It
does not claim a live confidential-compute deployment or hosted end-to-end run.

| Phase 9 requirement | Prepared implementation/evidence | Current state |
| --- | --- | --- |
| Deploy contract to NEAR testnet | Guarded `deploy-contract.mjs`, balance/key/code checks, initialization config, evidence output | **Complete**; deployed, initialized, and paused on testnet |
| Deploy worker and verify attestation | Digest-required compose, deployment runbook, verifier checklist, public identity derivation | Prepared; CVM/registry pending |
| Provision exact worker key | Public-key derivation plus guarded `finalize-worker-key.mjs`; verifies and leaves one exact two-method key | Prepared; live encrypted provisioning pending |
| Verify scheduled timeouts and batched roots | Worker implementation/tests plus hosted inspection and evidence steps | Locally verified; hosted evidence pending |
| Register approved TEE identity | Provisional paused bootstrap, guarded `register-hosted-tee.mjs`, identity-hash helper, attestation cross-check table | Automation complete; verified hosted values pending |
| Deploy API, MCP, frontend, database, ciphertext storage | Environment inventory and operator sequence | Hosting intentionally deferred |
| Run full two-agent test | Separate buyer/seller prompt profiles plus `two-agent-demo.mjs`; covers mismatch, match, delivery, actual credential use, confirmation, settlement, and withdrawals | Profiles and runner prepared; hosted execution pending |
| Exact judge reproduction steps | `deployment/JUDGE_REPRODUCTION.md` | Prepared; public URLs/hashes pending |
| Record demo | `deployment/DEMO_SCRIPT.md` | Script prepared; recording pending |
| Reused versus hackathon work | Root README section and `deployment/REUSE_DISCLOSURE.md` | Complete |
| Architecture, privacy, threat model, attestation | `SECURITY_AND_PRIVACY.md`, `ATTESTATION.md`, and diagrams | Complete |
| Confirm no committed secret | `check-secrets.mjs`, ignore rules, placeholder-only environment template | Complete for current working tree; rerun before publication |

## Prepared safety controls

- Every signing script is testnet-only and rejects a mainnet RPC URL.
- Contract deployment, deposits, and worker-key lockdown require explicit
  confirmation strings.
- Secret generation and token issuance write new mode-600 files and never print raw
  secret values.
- Evidence output contains public identifiers, hashes, statuses, and transaction
  references only.
- The hosted two-agent runner refuses development attestation.
- Live inspection verifies the contract configuration, the worker's sole restricted
  key, service health, public-state privacy, and local artifact hash.

## Remaining live inputs

1. A container registry and immutable worker image digest.
2. NEAR Confidential Compute/CVM access and encrypted environment provisioning.
3. Public HTTPS URLs and durable encrypted storage.
4. Two wallet-signed MCP grants and reusable pool deposits after verified unpause.
5. Hosted deal, attestation, final Explorer, and video evidence.

## Verification performed on 2026-10-24

- Five dedicated accounts were faucet-funded with 10 testnet NEAR each; the pool
  later received 4 additional testnet NEAR from the user.
- The contract was deployed, initialized, and immediately paused. The public
  transaction hashes and accounts are recorded in `deployment/TESTNET_STATE.md`.
- Live RPC inspection matched the 174,318-byte local WASM, confirmed `paused: true`,
  confirmed zero pool liability, and found no forbidden private deal fields in the
  public configuration.

- Phase 9 preflight passed with 28 required artifacts and 15 script syntax checks.
- The source secret scanner inspected 1,041 tracked/untracked non-ignored files and
  found zero private keys, MCP tokens, PEM keys, unsafe secret files, or populated
  secret environment values.
- Type checks passed for shared types, worker, privacy API, MCP, and integration
  packages.
- 88 backend and cross-service TypeScript tests passed: shared types 13, worker 38,
  privacy API 5, MCP 31, and cross-service integration 1.
- The demo API returned 200 for the delivered credential, 401 for an invalid
  credential, and 200 for health without logging the credential.
- Agent/deposit secret helpers created mode-600 files and did not print their secret
  values.
- The installed NEAR API exposes every method used by the deployment, initialization,
  restricted-key, and contract-call scripts.
- The contract artifact is 174,318 bytes with SHA-256
  `db42e4388c3b6603f13a31b8a06a132ac2fb7a44019eaa178e49345fda7c7fd5`.

No frontend source was modified or reworked during Phase 9 preparation.
