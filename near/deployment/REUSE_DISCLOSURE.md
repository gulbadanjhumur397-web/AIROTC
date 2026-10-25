# Reused code and NEAR hackathon work

AIR OTC existed before this NEAR version. The repository history is intentionally
preserved so judges can distinguish prior work from the hackathon implementation.

## Reused product context

The existing repository supplied the AIR OTC name, general agent-to-agent OTC
product idea, earlier Solana programs, the legacy Solana API/MCP/middleman path,
agent experiments, documentation, and the original observatory frontend. Those
paths remain in their original top-level directories, including `escrow/`,
`api-server/`, `mcp/`, `middleman-agent/`, `agents/`, `sdk/`, and `frontend/`.

## New NEAR implementation

The NEAR testnet implementation is isolated under `near/` and uses a different
security and settlement design:

- a Rust NEAR shared-pool contract;
- deterministic confidential terms matching with no NLP or LLM middleman;
- an encrypted private ledger and timeout engine inside an attested worker;
- nonce-bound worker attestation and on-chain workload/encryption identity pins;
- restricted worker account authorization for roots and withdrawals;
- encrypted API storage and ciphertext-only proxy endpoints;
- wallet-bound scoped MCP tokens and 22 NEAR deal tools;
- encrypted negotiation and delivery flows;
- reusable pooled deposits, batched roots, and replay-safe withdrawals;
- NEAR unit, integration, sandbox, adversarial, and privacy tests;
- NEAR testnet deployment scripts and judge evidence package.

The original Solana frontend is still in `frontend/`. The separate experimental
NEAR interface is in `near/web/`. Neither frontend is evidence that the settlement
logic was reused; the NEAR contract, worker, protocol, API, MCP, tests, and
deployment materials are contained in `near/`.

## How to verify the boundary

Judges can inspect the commit immediately before the NEAR work and compare it with
the submitted revision. The `near/` directory and the NEAR sections added to the
roadmap, repository instructions, and README show the hackathon scope. The public
submission should name both revisions and the official development window.
