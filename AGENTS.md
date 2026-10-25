# AIROTC implementation instructions

## Active objective

Phases 1–7 are complete. Phase 7 closed on 2026-10-25 after two independent MCP
processes completed the entire deal flow through the Fly-hosted privacy API and demo
product API, real NEAR testnet contract, and verified Phala confidential worker.

Phase 8 is complete with adversarial signature/tamper/replay/expiry tests, role and
wallet isolation, numeric and balance safety, worker identity rotation/rejection,
persistence and log leakage scans, timeout/cancellation/pause/recovery behavior,
live public-chain privacy inspection, hardware attestation, and a written
privacy-claim review.

## Completion status

Phases 4–6 were completed at the code and local-integration level on 2026-10-23. The authoritative comparison is `near/PHASES_4_6_TRACEABILITY.md`: 22/22 implementation tasks and 6/6 exit-criterion groups are mapped to passing evidence. Do not treat live testnet/CVM deployment or the independent two-agent public demo as part of this completion claim; those remain Phases 7–9.

Phase 7 hosted evidence is mapped in `near/PHASE_7_HOSTED_TRACEABILITY.md`: two
separate agent processes, wallets, wallet-signed MCP tokens, encrypted messages,
real testnet transaction references, verified confidential-compute evidence, and no
direct database access.

Phase 8 is complete: all 8/8 roadmap tasks have mapped evidence. In addition to
the 105-test local result, the latest live audit inspected 20 real NEAR testnet
transactions from the deployed worker flows: two deposits, thirteen batched
ledger-root anchors, and five withdrawals. It found no ticket, deal, terms, price,
collateral,
delivery, product, credential, or private-balance field on chain.

Phase 9 progress is recorded in `near/PHASE_9_PREDEPLOYMENT_TRACEABILITY.md`. The
testnet pool and a production Phala Cloud dstack CVM are deployed. The Intel TDX
quotes, event log, compose hash, image digest, nonce-bound worker identity, and
restricted worker key were independently verified on 2026-10-25. The verified
identity is registered and the pool is unpaused. Buyer and seller reusable deposits
were claimed into private balances. The privacy API and demo product API are hosted
as isolated `airotc-*` Fly apps, encrypted API state is on a dedicated Fly volume,
fresh wallet-signed hosted MCP grants were issued, and the real two-process MCP flow
passed through those public HTTPS services. The latest Explorer audit passed over 20
transactions. Only the presentation recording remains open; the frontend stays
undeployed unless the user explicitly requests it.
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

