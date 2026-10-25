# Phase 9 predeployment traceability

This comparison tracks the live Phase 9 deployment. The NEAR testnet contract and
Phala confidential worker are deployed and cryptographically bound. It does not
yet claim the remaining service hosting or the hosted two-agent end-to-end run.

| Phase 9 requirement | Prepared implementation/evidence | Current state |
| --- | --- | --- |
| Deploy contract to NEAR testnet | Guarded `deploy-contract.mjs`, balance/key/code checks, initialization config, evidence output | **Complete**; deployed, initialized, verified worker registered, and unpaused on testnet |
| Deploy worker and verify attestation | Production Phala dstack CVM, digest-pinned GHCR image, fresh worker/platform Intel TDX quotes, official verifier results, RTMR replay, compose/image/identity cross-check | **Complete**; live endpoint and public evidence recorded |
| Publish reproducible worker image from the public repository | GitHub Actions verifies the worker, builds `linux/amd64`, and publishes commit and `testnet` tags with `packages: write` | **Complete**; run `40171838109` published immutable digest `sha256:60e57b5c19ad23ff14e594026e6eccec804b65db199cfa8ad5a0aaed400da18c` |
| Provision exact worker key | Key injected through encrypted CVM environment; guarded lockdown left one function-call key for the exact pool and two methods | **Complete**; no FullAccess or additional worker key remains |
| Verify scheduled timeouts and batched roots | Automatic timeout tests plus live Phala maintenance; Explorer audit found eight root anchors and final sequence 11 | **Complete** |
| Register approved TEE identity | Verified worker proposal, delayed activation, exact on-chain hash checks, and unpause | **Complete** on NEAR testnet |
| Deploy API, MCP, frontend, database, ciphertext storage | Environment inventory and operator sequence | Hosting intentionally deferred |
| Run full two-agent test | Separate buyer/seller MCP processes completed mismatch, match, delivery, credential use, confirmation, settlement, and withdrawals against Phala and NEAR testnet | Real integration complete with local API/MCP boundary; public-hosting rerun still required for Phase 7 |
| Exact judge reproduction steps | `deployment/JUDGE_REPRODUCTION.md` | TEE and contract values recorded; remaining service and withdrawal URLs pending |
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

## Remaining live work

1. Public HTTPS URLs and durable encrypted storage for the privacy API, MCP server,
   demo API, and other non-TEE services.
2. New wallet-signed MCP grants issued by the hosted API. The existing deposits are
   already claimed in the persistent private ledger.
3. The publicly hosted two-agent rerun and video evidence.

## Verification performed on 2026-10-25

- Deployed production CVM `airotc-tee-worker-prod` on Phala Cloud dstack 0.6.1.
- Published and pinned worker image
  `sha256:049b534301d792f69950ce14cc46f0dbc9b1c2362c298de2e264c572cd8af445`.
- Removed the diagnostic SSH key before collecting final measurements.
- Verified the nonce-bound worker and platform Intel TDX quotes with Phala's
  official verifier; both returned successful proof-of-cloud verification.
- Replayed 31 measured events and reproduced RTMR0 through RTMR3.
- Verified compose hash
  `bc18c827cf5036f3e48481c07d4f427970dc21cf5eb2bea1557fd2453a9bc828`,
  the exact immutable image, production OS hash, app, instance, and encryption
  identity.
- Replaced the worker bootstrap key with one restricted operational key for only
  `anchor_ledger_root` and `withdraw`.
- Proposed and activated the verified identity after the contract's 60-second
  delay, then unpaused the pool.
- Final RPC inspection found the registered hashes, no pending rotation, exactly
  one restricted key, and no forbidden private deal fields in public state.
- Buyer and seller each attached one testnet NEAR as reusable pool funds. The two
  successful deposits produced a combined net liability of
  `1994980000000000000000000` yoctoNEAR after contract storage charges.
- Two separate MCP processes claimed the deposits, produced the expected
  `NO_MATCH` and `MATCH`, validated the delivered API credential, settled the deal,
  and completed buyer and seller withdrawals on NEAR testnet.
- The first withdrawal attempt exposed a 15-second API-to-worker timeout even
  though NEAR completed the transaction. Worker, API, MCP, and runner timeouts were
  corrected and the full flow then passed. Privacy API tests (5), MCP tests (31),
  and the end-to-end rerun passed.
- The Explorer audit decoded 13 real transactions: two deposits, eight roots, and
  three withdrawals. No private deal field appeared in function arguments, events,
  or public configuration.
- The public-repository GitHub Actions workflow completed successfully and
  published an immutable worker image from commit
  `9f9f8d7f7bbdc46b27bc9a1523632058dcf72a1c`. The running CVM remains pinned to its
  already attested image; deploying the new CI digest requires a fresh attestation
  and delayed on-chain identity rotation.

## Verification performed on 2026-10-24

- Five dedicated accounts were faucet-funded with 10 testnet NEAR each; the pool
  later received 4 additional testnet NEAR from the user.
- The contract was deployed, initialized, and immediately paused. The public
  transaction hashes and accounts are recorded in `deployment/TESTNET_STATE.md`.
- Live RPC inspection matched the 174,318-byte local WASM, confirmed `paused: true`,
  confirmed zero pool liability, and found no forbidden private deal fields in the
  public configuration.

- Phase 9 preflight passed with 32 required artifacts and 17 script syntax checks.
- The source secret scanner inspected 1,051 tracked/untracked non-ignored files and
  found zero private keys, MCP tokens, PEM keys, unsafe secret files, or populated
  secret environment values.
- Type checks passed for shared types, worker, privacy API, MCP, and integration
  packages.
- 91 TypeScript tests passed: shared types 13, worker 38, privacy API 5, MCP 31,
  browser 3, and cross-service integration 1.
- The demo API returned 200 for the delivered credential, 401 for an invalid
  credential, and 200 for health without logging the credential.
- Agent/deposit secret helpers created mode-600 files and did not print their secret
  values.
- The installed NEAR API exposes every method used by the deployment, initialization,
  restricted-key, and contract-call scripts.
- The contract artifact is 174,318 bytes with SHA-256
  `db42e4388c3b6603f13a31b8a06a132ac2fb7a44019eaa178e49345fda7c7fd5`.

No frontend source was modified or reworked during Phase 9 preparation.
