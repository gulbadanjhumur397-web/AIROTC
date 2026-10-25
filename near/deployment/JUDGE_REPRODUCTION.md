# Judge reproduction

No judge needs a private key, database login, TEE secret, or server shell.

## Public deployment record

- Human frontend: intentionally not deployed for this agent-first demonstration
- Privacy API health: `https://airotc-privacy-api-gulbadan.fly.dev/health`
- Demonstration API health: `https://airotc-demo-api-gulbadan.fly.dev/health`
- Confidential worker: `https://04e4341dee051bce7eddb75ec19d12e140714b60-8080.dstack-pha-prod9.phala.network`
- Pool contract: `airotc-hackathon-pool-20261023-25646d5e.testnet`
- TEE worker account: `airotc-hackathon-worker-20261023-25646d5e.testnet`
- Contract deployment transaction: `https://testnet.nearblocks.io/txns/HdtMh7AfnUcYh7AW9sKVmmNF2H7aGEvwZ84PnCApvrBw`
- Buyer reusable deposit: `https://testnet.nearblocks.io/txns/CocdYnM967rUMuCaLi2aWLsUwYiZXSa78HU48TBf7mFu`
- Seller reusable deposit: `https://testnet.nearblocks.io/txns/6CXARjy7oztajKeuvm9UbAj3pwvaVibBEiTURATVSPe5`
- Final buyer withdrawal: `https://testnet.nearblocks.io/txns/9Ejay9ugyiFohkNyjhZHA6Ujk58fpt6nYBxE6ke9Zo32`
- Final seller withdrawal: `https://testnet.nearblocks.io/txns/6HWGX1XuJc5mELQ9dPZa765b3NjyZ8SzDSDm6w8JdsfC`
- Worker image digest: `ghcr.io/gulbadanjhumur397-web/airotc-tee-worker@sha256:049b534301d792f69950ce14cc46f0dbc9b1c2362c298de2e264c572cd8af445`
- Verified compose hash: `bc18c827cf5036f3e48481c07d4f427970dc21cf5eb2bea1557fd2453a9bc828`
- Attestation verification record: `near/deployment/PHALA_TEE_STATE.md`
- Source branch: `near-testnet-hackathon`

## Five-minute verification

1. Open both health URLs and confirm the Fly-hosted API services are live.
2. Open the contract in NEAR Explorer. Confirm its code exists and `get_config`
   reports the worker account and workload hashes above.
3. Inspect the worker account access keys. It must have exactly one key, restricted
   to the pool contract methods `anchor_ledger_root` and `withdraw`.
4. Request a fresh worker attestation using a new random nonce. Verify the platform
   proof, replay the event log, confirm the digest-pinned compose hash, and confirm
   that report data binds the nonce and worker encryption identity.
5. Start the published deterministic two-agent scenario. Observe two separately
   authenticated MCP processes and no direct database access.
6. Observe the seller create an encrypted API-access listing and the buyer open an
   encrypted ticket.
7. Observe the first term round return `NO_MATCH`. Neither submitted term is
   displayed or stored by the public API.
8. Observe the second round return `MATCH` and `FUNDED` after both agents submit the
   same signed structured terms.
9. Observe encrypted delivery, buyer decryption, buyer confirmation, and private
   status `COMPLETED`.
10. Open both final withdrawal links. Confirm real NEAR testnet transfers from the
    shared pool to the buyer and seller.
11. Inspect all public events. Confirm they contain deposits, commitments, ledger
    roots, and withdrawals, but no ticket ID, product, plaintext term, deal price,
    collateral split, delivery payload, or private balance.
12. Compare the source revision, local WASM SHA-256, on-chain code hash, image
    digest, compose hash, and attestation evidence with the evidence bundle.

## Expected result

The buyer and seller finish one deal entirely through MCP. The deterministic worker
decides equality and settlement without NLP, an LLM middleman, or database access.
The public chain proves deposits and withdrawals while private deal details remain
inside encrypted clients and the attested worker.

## Scripted fallback

If an external agent model is unavailable, run `pnpm phase9:demo`. It invokes the
same 22 MCP tools through two separate MCP processes and exercises the same live
contract and confidential worker. The fallback does not call application classes or
the database directly.
