# Judge reproduction

Replace the bracketed public deployment values after hosting. No judge needs a
private key, database login, TEE secret, or server shell.

## Public deployment record

- Application: `[HTTPS frontend URL]`
- Privacy API health: `[HTTPS API URL]/health`
- Pool contract: `airotc-hackathon-pool-20261023-25646d5e.testnet`
- TEE worker account: `airotc-hackathon-worker-20261023-25646d5e.testnet`
- Contract deployment transaction: `https://testnet.nearblocks.io/txns/HdtMh7AfnUcYh7AW9sKVmmNF2H7aGEvwZ84PnCApvrBw`
- Final buyer withdrawal: `[NEAR Explorer URL]`
- Final seller withdrawal: `[NEAR Explorer URL]`
- Worker image digest: `[registry image@sha256:digest]`
- Verified compose hash: `[64 lowercase hex]`
- Attestation verification record: `[public evidence file or URL]`
- Source revision: `[Git commit]`

## Five-minute verification

1. Open the application and confirm it identifies NEAR testnet and the pool
   contract above.
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
