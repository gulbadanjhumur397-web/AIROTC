# Phase 8 security and privacy review

Review date: 2026-10-24

Scope: `near/shared-types`, `near/escrow-contract`, `near/tee-worker`, `near/privacy-api`, `near/mcp-server`, `near/web`, and the local/sandbox integration boundary.

This review covers locally reproducible code and NEAR sandbox evidence. A real NEAR testnet Explorer review and cryptographic verification of the deployed confidential VM remain Phase 9 deployment gates. Development attestation is never accepted as production evidence.

## Security result

No known critical or high-severity code issue remains open in the reviewed NEAR path. Six material findings were corrected during Phase 8:

| Finding | Previous behavior | Resolution |
|---|---|---|
| SEC-001 — worker-key substitution | Browser and MCP clients accepted the encryption identity returned by the API before checking an approved TEE policy. | Pool contract v2 stores the approved worker encryption-identity hash. Both clients read final pool policy from NEAR RPC and require a fresh nonce, exact worker ID, exact key hash, exact report-data binding, and exact compose hash before encrypting terms or actions. |
| SEC-002 — unrelated party key accepted | Party request signatures could use any access key present on the claimed NEAR account, including one scoped to another application. | Party identity verification now accepts only a full-access key or a function-call key whose receiver is the configured pool contract. This is separate from the worker operational key in SEC-006. |
| SEC-003 — browser secrets persisted | Browser token and session private keys were stored in `sessionStorage`. | They now remain only in page memory and are cleared on reload; key byte arrays are overwritten when the session is cleared. |
| SEC-004 — timeout required an external caller | Signed timeout rules existed, but an agent had to call `deal_timeout`. | The TEE worker now runs an internal scheduled maintenance pass that settles every due funding, seller, and buyer timeout without a caller. The manual tool remains an optional immediate trigger. |
| SEC-005 — one root per private transition | Lock, delivery, confirmation, and cancellation each immediately anchored a root, increasing gas and exposing fine-grained activity timing. | Production uses a bounded maintenance interval (15 seconds by default) and anchors at most one current root per pass. Withdrawals force-anchor first because the contract requires the current root. |
| SEC-006 — operational account could retain another key | Deployment instructions requested a two-method function-call key, but worker startup did not verify its permission or whether another account key could act with the same predecessor ID. | Startup now requires the provisioned two-method key to be the dedicated worker account's only key. FullAccess, a second key, the wrong receiver, an unrestricted method list, missing methods, and extra methods all fail. The sandbox deletes its bootstrap FullAccess key before the worker connects. |

## Trust boundaries

| Component | Plaintext it can observe | Security role |
|---|---|---|
| Browser or MCP process | Its own wallet keys, token, messages, submitted terms, received delivery | Encrypts private fields and signs exact structured actions locally. A compromised client can act as that user. |
| Privacy API | Wallet identity, token policy, ticket party mapping, listing category/tags, ciphertext, request timing | Enforces capability scopes, roles, replay IDs, and spending caps. It cannot decrypt messages, products, terms, delivery, or private ledger responses. Whole-file encryption protects offline database copies, not a compromised running API process. |
| Confidential worker | Exact terms, private balances, deal state, deposit allocation, delivery commitment | Verifies identities/signatures/nonces, performs exact matching and deterministic settlement, runs scheduled timeouts, and batches private-ledger roots. It does not receive delivery contents. |
| NEAR contract and observers | Pool/worker accounts, deposits, withdrawals, amounts, commitments, ledger roots, limits, pause/rotation state, transaction timing and fees | Custodies public pooled funds and allows only the registered worker account to anchor roots or withdraw. It never receives ticket IDs, product data, terms, price/collateral allocation, delivery commitment, or private balances. |
| Deployment owner | Worker registration and recovery proposals | Must independently verify the hardware quote, event log, compose manifest, image digest, and encryption identity before registering them. Rotation and recovery delays make changes public before activation. |

## Privacy claims

The system provides content confidentiality for product data, ticket messages, final terms in transit to the worker, delivery contents, and worker responses. It does not provide transaction-graph anonymity. Deposits and withdrawals remain public, and amount/timing correlation can reveal likely relationships. The ordinary API also sees wallet-to-ticket membership and traffic metadata.

The default agent flow checks and tops up a reusable private balance before terms are submitted, instead of depositing the exact required amount immediately after a match. Root batching reduces state-transition timing precision. These measures reduce correlation but do not make deposits, withdrawals, or their amounts private.

The TEE protects data only after the deployment quote and workload measurement are independently verified. A `DSTACK_CVM` label or unverified `/v1/Info` fields are insufficient. Phase 9 must use the official [NEAR AI Cloud verifier](https://github.com/nearai/nearai-cloud-verifier) or an equivalent DCAP verifier, inspect the attested compose manifest and digest-pinned image, then register the verified compose and encryption-key hashes on-chain.

No LLM, NLP model, chat message, API administrator, or middleman can authorize a match, release, refund, cancellation, or withdrawal. Those transitions require exact signed structured input and deterministic worker/contract checks.

## Failure and recovery behavior

- Seller misses delivery deadline: the internal maintenance pass gives the buyer its locked price/collateral plus seller collateral.
- Buyer does not confirm a recorded delivery: the internal maintenance pass releases payment and seller collateral after the confirmation deadline; buyer collateral returns.
- Both parties request cancellation before delivery: both balances unlock atomically.
- Funding deadline expires: unmatched funding locks are never created and the deal is cancelled.
- Root anchoring fails: encrypted state is preserved and the next maintenance pass or restart retries the current root.
- Withdrawal submission fails: the pending withdrawal is reconciled or refunded after expiry/retry exhaustion.
- Snapshot rollback, chain-root rollback, or root mismatch: worker startup fails closed.
- Worker compromise/replacement: owner pauses the pool, waits through delayed recovery, verifies replacement evidence, registers the new account/measurement/key hash, and explicitly resumes.

## Deployment gates still open

1. Verify a fresh real CVM quote, TCB status, event-log replay, compose hash, image digest/provenance, and nonce/key binding.
2. Register the verified worker account, compose hash, and encryption-identity hash in the deployed testnet contract.
3. Confirm through CVM secret provisioning and attestation evidence that the exact restricted worker key is available only to the measured workload; source code and local tests cannot prove this deployment fact.
4. Inspect real NEAR Explorer transactions, arguments, receipts, and events for every demo step and confirm that no private term appears.
5. Verify the hosted 15-second maintenance behavior and root batching, repeat the full security suite against hosted endpoints, then run the two independent hosted agents required by Phase 7.

