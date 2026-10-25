# Phases 1–3 completion record

Completed at the code and local-integration level on 2026-10-23. This record does not claim a live NEAR testnet or confidential-VM deployment; those external deployments remain in Roadmap Phase 9.

The detailed requirement-to-code comparison is in `PHASES_1_3_TRACEABILITY.md`: 26/26 implementation tasks and 9/9 exit-criterion checks are mapped to code and verification evidence.

## Phase 1 — shared protocol

- Versioned, exact-key final terms with explicit seller and buyer timeout rules.
- Canonical decimal atomic amounts, ordered deadlines, u128 bounds, and domain-separated hashes.
- Role- and NEAR-account-bound Ed25519 signatures.
- Signed, expiring, replay-protected worker actions.
- X25519/XSalsa20-Poly1305 request and response envelopes.
- Deposit and delivery commitments.
- A checked-in deterministic fixture verified by TypeScript and Rust.

## Phase 2 — NEAR shared pool

- Native-token deposits scoped by depositor plus secret commitment.
- Public pool liability with no ticket, product, deal, or private-balance records.
- Registered-worker-only ledger roots and withdrawals.
- Current-root, expiry, amount, replay, exact-retry, and rolling-window enforcement.
- Safe failed-transfer accounting across withdrawal-window rollover.
- Pause, delayed worker rotation, and delayed emergency recovery.
- Rust 1.93 and near-sdk 5.29 locks, optimized WASM build, and digest-pinned NEP-330 reproducible-build metadata.

## Phase 3 — deterministic confidential worker

- Exact structured matching with no NLP, LLM, or middleman decision path.
- On-chain NEAR access-key identity checks, signature checks, nonce replay rejection, and 24-hour request bounds.
- Private pooled balances, atomic funding locks, deterministic delivery/confirmation/cancellation/timeouts, and withdrawals.
- AES-256-GCM snapshots, structural and financial invariant checks, contract-root anchoring, stale-snapshot rejection, unfinished-anchor recovery, and withdrawal recovery.
- Nonce-bound dstack attestation evidence that commits to the worker account and request-encryption public key.
- Body-free structured request logs and production rejection of development attestation.
- A hardened container definition and digest-required confidential-VM compose manifest.

## Verification evidence

- Shared protocol: 9 tests.
- Confidential worker: 22 tests, including HTTP, encryption, tamper, replay, timeout, restart, withdrawal recovery, snapshot rollback, and withdrawal-policy binding.
- Rust contract: 11 unit tests, formatting, and clippy with warnings denied.
- NEAR Sandbox: 2 deployed-WASM tests. One validates the contract boundary; one drives the real worker through two deposits, private balance locking, delivery, settlement, root anchoring, and a completed withdrawal.
- Two clean local WASM builds were byte-identical: 170,595 bytes with SHA-256 `5cd9fa7b75590e6bbc4611865a510ccb1d34f031464b3bc7161ac96644cd746c`.

## External deployment boundary

Phase 9 needs a NEAR testnet owner, pool, worker, buyer, and seller account; a container registry; and NEAR confidential-compute access. That phase will publish the image by digest, deploy the worker, verify a fresh attestation, register the verified compose hash in the contract, and run the two-agent MCP scenario. No mainnet funds are required.
