# Phase 8 requirement-to-code comparison

Status: **7 local security tasks implemented; live testnet/CVM evidence remains deployment-dependent**.

Phase 7 is deliberately open until two independent agents complete the hosted flow. Phase 8 does not use a local two-agent simulation as Phase 7 evidence.

| Roadmap requirement | Implementation and adversarial evidence | State |
|---|---|---|
| Signature, tamper, replay, and expiry | Shared protocol tests alter terms, actions, ciphertext, nonce, context, and expiry; worker tests exercise nonce replay and expired/overlong requests; contract tests reject withdrawal replay/expiry. | Locally verified |
| Role and wallet isolation | Privacy API token/role/ticket isolation, MCP authorization matrix, worker buyer/seller/non-party denial, exact two-method operational-key validation, Rust predecessor checks, and an unauthorized-withdrawal sandbox test. | Locally verified |
| Insufficient balance and overflow | Canonical u128 validation, combined funding/payout overflow rejection, unfunded-deal behavior, insufficient withdrawal rejection, checked Rust arithmetic, contract caps and rolling limits. | Locally verified |
| TEE identity rotation and rejection | Pool v2 pins account + compose hash + encryption-key hash; delayed rotation rejects the old worker and accepts the new worker; browser/MCP fail closed on substituted key/nonce/compose/dev evidence. | Locally verified; real quote pending Phase 9 |
| Database and log leakage scans | Authenticated encrypted database/snapshot tamper tests, runtime sentinel scans of API/worker logs and persistence, MCP response secret guard, browser ciphertext-boundary tests, and `scripts/phase8-static-scan.mjs`. | Locally verified |
| NEAR explorer data inspection | Sandbox public views and contract surface are checked for ticket, terms, collateral allocation, and delivery fields. | Sandbox verified; real Explorer pending Phase 9 |
| Seller timeout, buyer timeout, cancellation, pause, recovery | Worker tests prove internal maintenance settles due deals without an agent call, batches multiple private transitions into one root, force-anchors before withdrawal, and covers seller penalty, buyer auto-release, mutual cancellation, funding expiry, anchor recovery, rollback rejection, and withdrawal reconciliation. Contract tests cover pause and delayed emergency worker recovery. | Locally verified |
| Privacy claims versus evidence | `PHASE_8_SECURITY_REVIEW.md` documents each observer, plaintext boundary, metadata leak, chain visibility, TEE trust requirement, and deployment limitation. | Locally verified |

## Verification commands

From `near/`:

```bash
pnpm typecheck
pnpm test
pnpm build
node scripts/phase8-static-scan.mjs
```

From `near/escrow-contract/` with the pinned Rust toolchain:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
pnpm run build
pnpm run test:sandbox
```

## Verified result

Run on 2026-10-24:

- TypeScript type checks passed across all seven runtime/test packages.
- 91 TypeScript tests passed: shared types 13, worker 38, privacy API 5,
  MCP 31, browser 3, and cross-service integration 1.
- 12 Rust contract unit tests passed.
- 2 NEAR sandbox deployment tests passed, including the worker's complete
  private-deal and withdrawal path against the deployed WASM.
- Rust formatting and strict Clippy (`-D warnings`) passed.
- All application production builds passed.
- Contract WASM built successfully with SHA-256
  `db42e4388c3b6603f13a31b8a06a132ac2fb7a44019eaa178e49345fda7c7fd5`.
- Static leakage scan passed across 38 production source files and 4
  environment files; the public contract surface contained zero private deal
  fields.

Total automated tests: **105 passed, 0 failed**.

Live CVM and Explorer evidence must be appended during Phase 9; no local
development evidence may replace it.

