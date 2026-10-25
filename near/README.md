# AIR OTC NEAR privacy core

This workspace contains the code-complete local implementation for roadmap Phases 1–6 and the locally provable security work in Phase 8 of the NEAR testnet migration:

- `shared-types`: versioned final terms, canonical encoding, NEAR-compatible Ed25519 signatures, X25519 authenticated encrypted envelopes, commitments, signed worker actions, and fixed protocol vectors.
- `escrow-contract`: a Rust NEAR shared pool. It publishes deposits and withdrawals while keeping ticket IDs, terms, price/collateral allocation, delivery, and private balances off-chain.
- `tee-worker`: the deterministic confidential state machine, automatic timeout scheduler, batched ledger/recovery layer, restricted NEAR adapter, dstack attestation endpoint, and confidential-VM deployment manifest.
- `privacy-api`: wallet-bound capabilities, encrypted-at-rest metadata, encrypted tickets and delivery, and ciphertext-only worker proxying.
- `mcp-server`: a 22-tool MCP stdio server that holds agent signing/encryption keys outside model-visible tool input and output.
- `web`: the NEAR testnet human interface, including wallet access, pool deposits, encrypted marketplace/tickets/delivery, exact terms review, TEE evidence, confirmation, and withdrawal.
- `integration-tests`: the browser-buyer/MCP-seller/API/real-worker ciphertext boundary test.

The NEAR path never imports or invokes the legacy Solana middleman. LLMs may act as buyer or seller agents through MCP, but no LLM or NLP output controls matching or settlement.

## Verify the workspace

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node scripts/phase8-static-scan.mjs
```

The Rust contract also requires `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, a WASM build, and `pnpm --filter @air-otc/near-escrow-contract test:sandbox`.

The sandbox suite deploys the WASM to a current local NEAR node and also runs the confidential worker against that real contract through deposit claim, exact match, balance lock, delivery, settlement, root anchoring, and withdrawal.

## Public and private boundary

Public on NEAR testnet: pool account, depositor/recipient accounts, deposit and withdrawal amounts, commitments, transaction timing, current ledger root, worker account, compose measurement, limits, pause state, and recovery proposals.

Private inside the verified workload: ticket-to-party mapping, exact terms, price/collateral allocation per deal, internal balances, deposit-to-deal allocation, delivery commitment, cancellation votes, and settlement status. Public transaction timing can still permit correlation; the MVP does not provide shielded deposits or withdrawals.

The snapshot key, request decryption key, and NEAR function-call key are separate secrets. They are supplied through encrypted confidential-VM provisioning and never stored in this repository. Worker startup requires the dedicated worker account to contain exactly the provisioned function-call key for `anchor_ledger_root` and `withdraw` on the configured pool contract; another key or permission aborts startup.

Agents default to reusable private pool balances: check and top up before negotiation, reuse the balance across deals, and withdraw on request. The production worker checks timeouts and batches pending roots every 15 seconds by default. A withdrawal force-anchors the current state before the contract moves funds.

## Current completion boundary

Phases 4–6 are complete in code and local integration. `PHASES_4_6_TRACEABILITY.md` maps every roadmap item and exit criterion to source and test evidence. `PHASE_8_TRACEABILITY.md` maps seven completed local security tasks; the real Explorer inspection remains open until Phase 9 creates testnet transactions.

Phase 7 is deliberately open. It is complete only after two independent agents use separate wallets and MCP tokens to finish the full deal flow through the hosted application, deployed testnet pool, and verified confidential worker. Live accounts, hosting, CVM verification, Explorer evidence, and the judge demonstration belong to Phase 9.

The non-hosted Phase 9 package is prepared under `deployment/` and `scripts/`. The
testnet pool address and paused bootstrap transactions are recorded in
`deployment/TESTNET_STATE.md`; the pool stays paused until a verified hosted TEE
identity is rotated in.
`PHASE_9_PREDEPLOYMENT_TRACEABILITY.md` maps each remaining live requirement to its
deployment command, verification step, and evidence file. No frontend files were
changed as part of that preparation.
