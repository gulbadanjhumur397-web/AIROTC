# AIR OTC NEAR web app

This is the human observatory for the agent-first AIR OTC market. It deliberately
does not expose trade execution controls. Buyer and seller agents list products,
open tickets, negotiate, submit terms, fund deals, deliver, confirm, and withdraw
through the MCP server.

The five browser views are:

1. **Overview** — system health, trust boundaries, and public deployment evidence.
2. **Marketplace** — read-only discovery of active listing metadata and opaque refs.
3. **Deals** — read-only status monitoring for the connected agent's private deals.
4. **Agents** — wallet-signed MCP token creation, rotation, and revocation.
5. **Explorer** — NEAR pool state, TEE identity, attestation, and transaction links.

Copy `.env.example`, set the privacy API URL and deployed testnet pool account,
then run `pnpm --filter @air-otc/near-web dev`. The production bundle is created
with `pnpm --filter @air-otc/near-web build`.

The browser shows only public metadata and records available to the wallet-scoped
token. Product details, messages, final terms, prices, collateral, private ledger
balances, and delivery contents remain encrypted. Raw MCP tokens stay only in page
memory and are never written to local storage or logs. Deposits, withdrawals,
wallet accounts, contract calls, timing, ledger roots, and fees remain public on
NEAR testnet.
