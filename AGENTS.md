# AIROTC implementation instructions

## Active objective

Phases 1–6 are complete at the code and local-integration level. Phase 7 is intentionally deferred: do not mark it complete until two independent agents complete the entire MCP deal flow against the hosted application, real NEAR testnet contract, and verified confidential-compute deployment.

The locally provable parts of Phase 8 are complete: adversarial signature/tamper/replay/expiry tests, role and wallet isolation, numeric and balance safety, worker identity rotation/rejection, persistence and log leakage scans, timeout/cancellation/pause/recovery behavior, sandbox public-chain privacy inspection, and a written privacy-claim review. Deployment-dependent NEAR Explorer and hardware-attestation evidence remains open until Phase 9.

## Completion status

Phases 4–6 were completed at the code and local-integration level on 2026-10-23. The authoritative comparison is `near/PHASES_4_6_TRACEABILITY.md`: 22/22 implementation tasks and 6/6 exit-criterion groups are mapped to passing evidence. Do not treat live testnet/CVM deployment or the independent two-agent public demo as part of this completion claim; those remain Phases 7–9.

Phase 7 may only be completed from hosted evidence: two separate agent processes, wallets, and MCP tokens; real testnet transaction references; verified NEAR confidential-compute evidence; and no direct database access.

Phase 8 currently has 7/8 roadmap tasks completed. The verified local result is
105 tests passing (91 TypeScript/integration, 12 Rust unit, 2 NEAR sandbox),
strict Rust formatting/linting, successful application and WASM builds, and a
clean static privacy scan. The remaining task is inspection of actual NEAR
Explorer transactions created after Phase 9 deployment.

Phase 9 progress is recorded in `near/PHASE_9_PREDEPLOYMENT_TRACEABILITY.md`. The
testnet pool is deployed, initialized, and paused with an explicitly provisional
identity. Hosting, live CVM attestation, worker-key lockdown, verified identity
rotation/unpause, reusable deposits, final Explorer evidence, the hosted two-agent
run, and video remain open.
Do not modify either frontend unless the user explicitly requests frontend work.

## Non-negotiable architecture

- Do not use NLP, an LLM, or a middleman for agreement or settlement.
- Ticket conversation never controls escrow state.
- Buyer and seller independently sign the same versioned structured terms.
- The confidential worker returns `MATCH` only for byte-identical canonical terms after identity, signature, nonce, and expiry validation.
- The public contract must not store ticket IDs, deal IDs, product information, exact deal price, collateral split, or private balances.
- Public testnet deposits and withdrawals remain observable and must be documented honestly.
- The model must never receive wallet, ledger, or encryption private keys.
- Amounts use unsigned atomic-unit integer strings at TypeScript boundaries and `u128` internally in Rust.
- Sensitive values must not appear in logs, events, panic messages, or test evidence.
- Production batches private-ledger roots on the internal maintenance interval and force-anchors before withdrawals.
- The dedicated worker account must contain exactly one key: the function-call key scoped to `anchor_ledger_root` and `withdraw`; FullAccess and additional keys are forbidden.

## Completion gates

Do not mark Phases 1–3 complete until all applicable gates pass:

- Shared-types typecheck, build, unit tests, and fixed test vectors pass.
- The Rust contract formats, lints, unit-tests, builds to WASM, and passes NEAR sandbox integration tests.
- The worker typechecks, builds, and passes unit and HTTP integration tests.
- Restart recovery, tamper rejection, replay rejection, exact mismatch, timeout, withdrawal retry, and unauthorized caller tests pass.
- A local integration test connects the worker to a contract-compatible gateway and proves deposit credit, balance lock, settlement, root anchoring, and withdrawal recovery.
- No production path imports or invokes the legacy `middleman-agent`.
- Environment examples contain placeholders only; no secret is committed.
- READMEs document setup, trust assumptions, privacy limits, and deployment.

For Phases 4–6, do not mark complete until:

- The privacy API typechecks, builds, and passes storage, authorization, rate-limit, ciphertext-proxy, leakage, and restart tests.
- Raw tokens, private keys, plaintext messages, terms, delivery payloads, products, and balances never appear in persistence or logs.
- The MCP service typechecks, builds, exposes every Phase 5 tool, binds every token to one immutable wallet, rejects scope/role/replay/policy violations, and never returns secrets.
- The frontend typechecks and builds, supports the human Phase 6 flow, performs encryption/decryption locally, and contains no secret-logging or plaintext private-field API path.
- A local integration test drives the frontend/MCP-compatible clients through the Phase 4 API and Phase 3 worker boundary using ciphertext only.
- A requirement-to-code traceability document maps every Phase 4–6 task and exit criterion to implementation and test evidence.

For Phase 8, do not mark a task complete until its adversarial test or inspection passes and is mapped in `near/PHASE_8_TRACEABILITY.md`. Do not count a development attestation as genuine TEE evidence. Do not claim the live Explorer inspection complete from sandbox data; repeat that check after Phase 9 deployment.

## Working rules

- Keep legacy Solana code intact unless a migration requires an isolated change.
- Exclude legacy Solana and middleman services from the NEAR runtime path.
- Prefer pure domain modules with injected clock, storage, attestation, identity, and contract adapters so security behavior is testable.
- Pin critical formats with explicit versions and domain-separated hashes.
- Treat TEE attestation and persistent key provisioning as separate claims; never imply that a VM quote proves the application workload unless deployment evidence binds the workload measurement.

