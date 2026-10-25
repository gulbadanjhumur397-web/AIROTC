# Phases 1–3 requirement-to-code traceability audit

Audit date: 2026-10-23

Scope: Roadmap Phases 1–3 and the completion gates in `AGENTS.md`. This audit measures code and local integration completeness. It does not count live NEAR testnet deployment, image publication, a live confidential VM, MCP tools, or the two-agent demonstration; those are later roadmap phases.

Result: all 26 Phase 1–3 implementation tasks and all 9 exit-criterion checks have implementation and verification evidence. No Phase 1–3 roadmap item is unmapped. The code/local-integration scope is 35/35 verified.

Status meanings:

- **Verified**: implementation exists and the applicable automated check passed.
- **External boundary**: code and deployment artifacts exist, while proof from a live third-party environment belongs to a later phase.

## Phase 1 — shared types and cryptographic envelopes

| Roadmap requirement | Implementation evidence | Verification evidence | Status |
| --- | --- | --- | --- |
| Create shared versioned term types | `shared-types/src/terms.ts`: `FinalTermsV1`, `TERMS_VERSION`, exact allowed keys, explicit buyer and seller timeout policies | `shared-types.test.ts`: canonical-form and invalid-value tests | **Verified** |
| Implement canonical encoding | `shared-types/src/encoding.ts`: `canonicalObjectJson`; `terms.ts`: `normalizeTerms` and `canonicalizeTerms` | “produces one stable canonical form and hash”; rejects floats, leading zeros, unknown fields, and unordered deadlines | **Verified** |
| Implement signature envelopes | `shared-types/src/signatures.ts`: role/account-bound Ed25519 term signatures; `actions.ts`: signed worker actions | Role-bound signing, impersonation, tampering, actor/nonce/expiry tests | **Verified** |
| Implement encrypted submission envelopes | `shared-types/src/encryption.ts`: X25519/XSalsa20-Poly1305 envelopes with key-ID and context binding; plaintext and ephemeral secret buffers are wiped after use | Encryption round-trip, context mismatch, and modified-ciphertext tests | **Verified** |
| Add nonce and expiry validation | `actions.ts` validates canonical nonce and expiry fields; `tee-worker/src/worker.ts` enforces one-time nonces, expiration, and a 24-hour maximum request lifetime | Replay, expired-request, and excessive-lifetime worker tests | **Verified** |
| Create cross-language test vectors | `shared-types/fixtures/protocol-v1.json` and `shared-types/scripts/generate-test-vector.mjs` | TypeScript byte-for-byte fixture test and Rust `rust_tooling_matches_the_shared_protocol_vector` test | **Verified** |
| Pin identical hashes across shared package, TEE, and Rust tooling | Domain-separated hashes in `hash.ts`, `terms.ts`, and worker ledger logic; Rust reads the checked-in fixture | Shared fixture and Rust hash comparison pass | **Verified** |
| Buyer and seller independently produce the same commitment | Both roles normalize and hash the same exact-key structure; signatures bind the same `termsHash` | Stable canonical/hash test and exact-match worker test | **Verified** |
| A one-byte/field difference produces `NO_MATCH` | `ConfidentialWorker.submitTerms` checks both hash equality and canonical-byte equality | `returns NO_MATCH ... and supports a new round` | **Verified** |
| Tampered messages and replayed nonces are rejected | Authenticated encryption, detached signatures, and persisted nonce registry | Signature tampering, ciphertext tampering, and nonce replay tests | **Verified** |

## Phase 2 — NEAR shared-pool contract

| Roadmap requirement | Implementation evidence | Verification evidence | Status |
| --- | --- | --- | --- |
| Implement the shared-pool contract with the stable NEAR Rust SDK | `escrow-contract/src/lib.rs`; pinned Rust 1.93 and `near-sdk` 5.29.1 in `Cargo.toml`/`Cargo.lock` | Rust build, formatting, unit tests, clippy, and WASM build pass | **Verified** |
| Implement deposits and commitment events | `deposit`, depositor-scoped `deposit_key`, `get_deposit`, net storage credit, liability accounting, NEP-style JSON event | Unit deposit/liability test and deployed-sandbox deposit query | **Verified** |
| Implement TEE-authorized withdrawals | `withdraw` requires the registered worker and current ledger root; asynchronous callback finalizes or restores liability | Sandbox proves an outsider cannot withdraw and the worker can complete a withdrawal | **Verified** |
| Implement replay protection | Withdrawal IDs are stored permanently; completed/pending IDs cannot be reused; failed retries must exactly match and are capped at three | Replay-safe withdrawal and exact-retry tests | **Verified** |
| Implement root anchoring | `anchor_ledger_root` requires the worker, validates hashes, advances sequence, and permits exact idempotent retry | Unauthorized anchor, idempotency, and real worker-to-contract anchoring tests | **Verified** |
| Implement limits, pause, rotation, and emergency recovery | Per-withdrawal and rolling-window limits, pause guard, delayed rotation, seven-day paused recovery, and owner controls | Excessive/rate-limit, old-window callback, rotation-delay, and recovery-delay tests | **Verified** |
| Add unit and sandbox tests | Rust unit module and `sandbox-test/pool.ava.js` | 12 Rust unit tests and 2 deployed-WASM sandbox scenarios pass | **Verified** |
| Add reproducible-build metadata and verify stable output | Digest-pinned NEP-330 metadata in `Cargo.toml`; build wrapper emits the WASM and checksum | Two clean local builds produced identical 170,595-byte WASM | **Verified** |
| All contract tests pass | Unit, formatting, lint, build, and sandbox commands completed successfully | 11/11 unit tests and 2/2 sandbox scenarios | **Verified** |
| Compiled contract deploys to NEAR Sandbox | Sandbox setup deploys `build/air-otc-pool.wasm` and calls `new` | Both deployed-contract scenarios pass | **Verified** |
| Unauthorized, expired, replayed, and excessive withdrawals fail | Worker guard, expiry window, permanent ID state, maximum amount, and rolling window in `withdraw` | Deployed unauthorized test plus unit expiry, replay, per-withdrawal, and rate-limit tests | **Verified** |

## Phase 3 — deterministic confidential worker

| Roadmap requirement | Implementation evidence | Verification evidence | Status |
| --- | --- | --- | --- |
| Implement identity and attestation endpoints | `server.ts`: `/v1/identity` and `/v1/attestation`; `attestation.ts`: dstack `/v1/Info` and `/v1/Attest` adapter | Server and attestation-provider tests | **Verified** |
| Implement encrypted term submission | `/v1/terms` accepts only an encrypted envelope; worker decrypts inside the service and encrypts its response to the signed reply key | HTTP encrypted-terms test and plaintext-rejection test | **Verified** |
| Implement signature verification | Shared term/action verification plus `NearRpcIdentityVerifier` access-key lookup | Tamper, impersonation, replay, and worker-flow tests | **Verified** |
| Implement exact terms matching | `submitTerms` requires identical versioned canonical terms and hashes; no NLP/LLM/middleman import exists in the NEAR path | Exact-match and `NO_MATCH` tests; source audit finds no production middleman dependency | **Verified** |
| Implement private account and deal ledgers | `types.ts`, `state.ts`, and encrypted `snapshot-store.ts`; public contract stores no deals or private balances | State invariants, snapshot round-trip, and public-config assertions | **Verified** |
| Implement atomic balance locking | Mutex-serialized worker operations and `tryFundDeal` debit/lock transition with u128-safe arithmetic | Full match/funding test and deployed contract-worker scenario | **Verified** |
| Implement delivery, confirmation, cancellation, and timeouts | `submitDelivery`, `confirmDelivery`, `requestCancellation`, `processTimeout`, `settleSuccessful`, and `unlockDeal` | Seller timeout, buyer auto-release, mutual cancellation, funding-expiry, and successful settlement tests | **Verified** |
| Implement withdrawal authorization | Signed withdrawal action, available-balance debit, current anchored root, deterministic ID, contract submission, and reconciliation | Successful withdrawal and failed-withdrawal restart recovery tests | **Verified** |
| Implement encrypted snapshots, rollback detection, and recovery | AES-256-GCM authenticated snapshot with atomic rename; chain sequence/root reconciliation and pending anchor/withdrawal recovery | Tamper rejection, saved-anchor recovery, snapshot rollback, root mismatch, and withdrawal recovery tests | **Verified** |
| Add redacted structured logging | `server.ts` logs only request ID, method, path, status, and duration; query strings and bodies are excluded | HTTP tests verify private input is not echoed; source review confirms the logger fields | **Verified** |
| Build container and digest-required confidential deployment manifest | `tee-worker/Dockerfile`, `.dockerignore`, `deployment/docker-compose.tee.yml`, and deployment guide; compose requires an immutable image digest and production dstack socket | Configuration tests reject development attestation in production; manifest/source audit completed | **Verified** |
| Artifact produces nonce-bound dstack attestation evidence | `attestationReportData` binds caller nonce, worker account, encryption key ID, and encryption public key; provider retrieves current dstack evidence | Nonce-binding and guest-API tests pass | **Verified** for code/artifact; live quote verification is an **external boundary** in Phase 9 |
| Plaintext private data does not leave the worker | Encrypted request/response boundary, encrypted snapshots, body-free logs, public contract limited to deposits/withdrawals/root/config | HTTP plaintext rejection, encrypted response, snapshot plaintext absence, and contract public-state tests | **Verified** within the implemented worker boundary |
| Restart and snapshot recovery tests pass | Startup reconciles chain root/sequence and pending withdrawals | Anchor failure, stale snapshot/root mismatch, tamper, and withdrawal restart tests pass | **Verified** |

## Completion-gate execution evidence

| Gate | Result |
| --- | --- |
| Frozen dependency lock | `pnpm install --frozen-lockfile --offline` passed after dependencies were restored |
| TypeScript typecheck and production build | Passed for shared types and worker |
| Shared protocol tests | 9/9 passed |
| Confidential worker tests | 22/22 passed across 5 files |
| Rust formatting | `cargo fmt --check` passed |
| Rust strict linting | `cargo clippy --all-targets -- -D warnings` passed |
| Rust unit tests | 12/12 passed |
| NEAR Sandbox | 2/2 deployed-WASM scenarios passed |
| Deterministic WASM | Two clean builds matched at 170,595 bytes; SHA-256 `5cd9fa7b75590e6bbc4611865a510ccb1d34f031464b3bc7161ac96644cd746c` |
| Secret/source audit | No committed private key or seed; environment file contains placeholders; fixture contains public keys only |
| Legacy decision path audit | No production NEAR code imports or invokes `middleman-agent`, OpenAI, Anthropic, an NLP classifier, or an LLM settlement path |

## Remaining work outside Phases 1–3

The following items do not reduce the Phase 1–3 code/local score because the roadmap assigns them to later phases:

- Deploy the pool contract and accounts on NEAR testnet.
- Publish the worker image under an immutable registry digest.
- Deploy the image to NEAR Confidential Compute and independently verify a fresh real quote, event log, compose hash, and image digest.
- Implement API/ticket storage, frontend screens, MCP tools, and two-agent orchestration.
- Run the public testnet two-agent end-to-end judge demonstration.

