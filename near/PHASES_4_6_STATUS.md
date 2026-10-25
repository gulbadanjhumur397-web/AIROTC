# Phases 4–6 completion record

Completed at the code and local-integration level on 2026-10-23. This record does not claim live NEAR testnet or confidential-VM deployment; those external operations remain in Roadmap Phase 9.

The detailed requirement-to-code comparison is in `PHASES_4_6_TRACEABILITY.md`: 22/22 implementation tasks and 6/6 exit-criterion groups are mapped to source and test evidence.

## Phase 4 — API and encrypted storage

- AES-256-GCM authenticated encryption covers the complete persisted API state; raw-file leakage and tamper/restart tests pass.
- Products, dual-recipient ticket chat, delivery, terms, and worker actions cross API boundaries only as authenticated X25519 ciphertext envelopes.
- Listings, tickets, messages, deliveries, and tokens use opaque random references; atomic values are canonical decimal strings.
- The NEAR runtime has no legacy middleman/NLP call path.
- Fixed-window rate limiting, exact browser origin control, bounded bodies, no-store headers, and body/query/token-free audit events are implemented.
- Only the confidential worker can validate terms, mutate private balances, or produce withdrawal authorization.

## Phase 5 — MCP security and tools

- Tokens are granted through a one-use NEP-413 challenge signed by an authorized full-access key and permanently bound to that wallet.
- Exact scopes, buyer/seller roles, expiry, request replay protection, rotation, revocation, and atomic withdrawal caps are enforced at the API.
- Withdrawal sidecar accounting is cryptographically bound to the signed encrypted amount and checked inside the worker.
- The stdio MCP service exposes 22 marketplace, ticket, terms, pool, attestation, delivery, deal, withdrawal, and token tools with JSON schemas.
- Signing/encryption keys and replacement tokens never appear in model-visible tool input or output.
- A 26-case authorization/replay matrix covers every mutating/high-impact MCP tool, plus discovery, local encryption, local decryption, and secret-output rejection.

## Phase 6 — frontend

- NEAR testnet Wallet Selector connects the human wallet and signs scoped NEP-413 token grants.
- The browser completes pool deposit/claim/balance, marketplace, encrypted ticket chat, two-step exact terms review/sign, TEE identity/attestation, encrypted delivery, confirmation, token lifecycle, and withdrawal.
- Browser cryptography keeps products, messages, terms/actions, and delivery plaintext out of API requests.
- The UI distinguishes private data from public deposit, withdrawal, account, timing, and fee metadata and explains both timeout rules.
- Type checking, privacy-boundary tests, and production bundling pass.

## Cross-boundary proof

The local integration suite starts the real Phase 3 confidential worker and Phase 4 API, then drives an MCP seller and browser buyer through encrypted listing, ticket, chat decryption by the counterparty, dual exact signed terms, TEE match, and leakage assertions. Persistence and API/worker logs are checked for private product, chat, terms, and raw token sentinels.
