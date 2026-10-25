# AIR OTC NEAR MCP server

This is a newline-delimited JSON-RPC MCP stdio server. It implements `initialize`, `ping`, `tools/list`, and `tools/call` and exposes 22 tools:

- Marketplace: `marketplace_list`, `marketplace_create`
- Tickets: `ticket_create`, `ticket_list`, `ticket_get`, `ticket_messages`, `ticket_send_message`
- Terms and TEE: `terms_submit`, `pool_identity`, `pool_attestation`
- Pool: `pool_claim_deposit`, `pool_get_balance`
- Delivery: `delivery_store`, `delivery_get`, `delivery_submit`, `delivery_confirm`
- Deal state: `deal_status`, `deal_cancel`, `deal_timeout`
- Funds and access: `withdrawal_request`, `token_rotate`, `token_revoke`

The process holds one wallet's scoped API token, Ed25519 signing seed, and X25519 encryption secret. These values are supplied through the process environment, never accepted as tool arguments, never returned in tool responses, and never logged. Rotation replaces the token inside the process and returns only non-secret metadata.

Before encrypting any terms or private-ledger action, the MCP process reads the final pool configuration directly from NEAR RPC, requests fresh nonce-bound worker evidence, and checks the worker account, encryption-identity hash, report-data binding, and compose hash. It fails closed when the pool is paused, the policy cannot be read, or any binding differs. Development evidence is disabled by default.

## Run

Build with `pnpm --filter @air-otc/near-mcp-server build`, configure the placeholders in `.env.example` through a local secret manager, and launch `node dist/index.js`. Point an MCP client at that command and environment. Run a separate process, wallet, key set, and token for each buyer or seller agent.

The API enforces immutable token identity, scopes, roles, replay IDs, expiry, revocation, and cumulative/per-action withdrawal caps. The worker independently verifies the signed NEAR identity, nonces, expiry, exact terms, deal role, and the withdrawal amount commitment.

## Default agent funding flow

Agents should treat the private pool as a reusable balance rather than deposit the exact deal amount immediately after a match:

1. Call `pool_get_balance` before negotiation or `terms_submit`.
2. If the balance is low, ask the user's wallet signer to create a pool deposit, then call `pool_claim_deposit` with its secret.
3. Reuse the credited private balance across deals and withdraw only when the user requests it.

This default reduces the timing and amount correlation created by a deposit made directly after one terms match. Pool deposits and withdrawals are still public on NEAR. The worker's internal scheduler processes expired deal timeouts; `deal_timeout` remains available as an idempotent manual trigger when a caller wants immediate processing after a deadline.
