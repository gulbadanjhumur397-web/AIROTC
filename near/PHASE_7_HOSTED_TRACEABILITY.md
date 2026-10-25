# Phase 7 hosted two-agent traceability

Status: **complete on 2026-10-25**.

This comparison uses the real Fly-hosted API boundary, production Phala Intel TDX
worker, deployed NEAR testnet pool, two independent MCP processes, separate wallets,
and separate wallet-signed tokens. Neither process accessed the database directly.

| Phase 7 requirement | Hosted evidence | State |
| --- | --- | --- |
| Independent buyer and seller profiles | Separate deterministic buyer and seller prompts, accounts, signing keys, encryption keys, and MCP processes | Complete |
| Separate MCP grants and testnet accounts | Fresh hosted token IDs `token_zsr0mcqbnNcEtj2N4hhscsAb` and `token_eDGxF6vjDf8HhAqLKyml5JB4`, immutably bound to different funded testnet wallets and roles | Complete |
| Spending limits | Buyer and seller grants carried exact per-action and cumulative withdrawal policies enforced by the API and worker | Complete |
| Demonstration API-key product | `https://airotc-demo-api-gulbadan.fly.dev/v1/proof` accepted only the privately delivered credential | Complete |
| Agent-only MCP interaction | Two independent stdio MCP processes exposed 22 tools each; the runner used only `tools/list` and `tools/call` | Complete |
| Intentional mismatch | Buyer returned `WAITING_FOR_COUNTERPARTY`; seller returned `NO_MATCH` without receiving the buyer terms | Complete |
| Exact match and balance lock | Matching signed canonical terms returned `MATCH` and deal status `FUNDED` | Complete |
| Encrypted delivery and product use | Buyer decrypted the delivery and successfully called the HTTPS demonstration API | Complete |
| Confirmation and settlement | Buyer confirmation produced final deal status `COMPLETED` | Complete |
| Real withdrawals | Buyer transaction `9Ejay9ugyiFohkNyjhZHA6Ujk58fpt6nYBxE6ke9Zo32`; seller transaction `6HWGX1XuJc5mELQ9dPZa765b3NjyZ8SzDSDm6w8JdsfC` | Complete |
| Redacted evidence | Ignored `evidence/two-agent-hosted-fly.json` records 18 successful tool calls, public references, commitments, statuses, and transaction hashes without terms, tokens, keys, credentials, or balances | Complete |
| Public-chain privacy | `verify-live-privacy.mjs` decoded 20 transactions: 2 deposits, 13 root anchors, and 5 withdrawals; no forbidden private field was found | Complete |

## Hosted resources

- Privacy API: `https://airotc-privacy-api-gulbadan.fly.dev`
- Encrypted state: dedicated encrypted 1 GB Fly volume `airotc_privacy_data`
- Demo product API: `https://airotc-demo-api-gulbadan.fly.dev`
- Confidential worker:
  `https://04e4341dee051bce7eddb75ec19d12e140714b60-8080.dstack-pha-prod9.phala.network`
- Pool: `airotc-hackathon-pool-20261023-25646d5e.testnet`

Both Fly Machines run in `sin`, expose only HTTPS through Fly Proxy, use health
checks, and stop when idle. The existing `air-arena-*` applications were not
modified. MCP remains a per-agent stdio process because it holds one agent's token,
signing seed, and encryption secret; it is intentionally not a shared public server.

## Final public ledger state

- Sequence: `16`
- Root: `2ed0d49e157252a322a8c14d93d138f285c049f34693016cb7716cc5a87707d8`
- Pool liability: `1994975000000000000000000` yoctoNEAR

The ignored evidence files are `evidence/two-agent-hosted-fly.json` and
`evidence/live-explorer-hosted-fly.json`.
