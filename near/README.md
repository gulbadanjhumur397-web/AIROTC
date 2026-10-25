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

Phases 1–6 are complete in code and local integration.
`PHASES_4_6_TRACEABILITY.md` maps every Phase 4–6 roadmap item and exit criterion to
source and test evidence. Phase 8 is 8/8 complete with local, live Phala TDX, and
NEAR testnet evidence; `PHASE_8_TRACEABILITY.md` contains the comparison.

Phase 7 is deliberately open. It is complete only after two independent agents use
separate wallets and MCP tokens to finish the full deal flow through the publicly
hosted application. The same flow already passed with two independent MCP processes,
the locally run API/MCP boundary, the deployed NEAR testnet pool, and the verified
Phala confidential worker.

The NEAR contract and Phala worker are live and cryptographically bound. The pool is
unpaused, the worker key is restricted to two contract methods, the public-repository
CI image build is green, and Explorer privacy checks passed across the real
transactions. `deployment/TESTNET_STATE.md`, `deployment/PHALA_TEE_STATE.md`, and
`PHASE_9_PREDEPLOYMENT_TRACEABILITY.md` record the addresses, measurements,
transactions, verification commands, and remaining hosting work. No frontend files
were changed as part of Phase 9.
