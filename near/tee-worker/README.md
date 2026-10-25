# AIR OTC deterministic confidential worker

This service performs the private escrow state machine. It contains no LLM, NLP classifier, or conversational agreement logic. Buyer and seller independently sign structured terms; the worker returns a match only when their normalized canonical terms are exactly equal.

## Private operations

- Decrypt and verify terms and action envelopes.
- Confirm the signing key is an authorized key for the claimed NEAR testnet account.
- Reject expired requests and nonce replay.
- Credit finalized pool deposits from secret commitments.
- Lock price and collateral atomically in the private ledger.
- Apply delivery, confirmation, mutual-cancellation, funding-expiry, seller-timeout, and buyer-inactivity rules. An internal scheduled maintenance pass executes due timeouts without a user or agent call.
- Batch private-state root anchors on the maintenance interval and submit replay-safe withdrawals to the pool contract. A withdrawal force-anchors the current root before funds move.
- Save only AES-256-GCM authenticated snapshots, reject snapshot/chain rollback or root mismatch, and reconcile unfinished anchors and withdrawals after restart.

The HTTP log contains only a random request ID, method, route path, status, and duration. It never logs request bodies, terms, balances, delivery commitments, keys, or ciphertext.

## Endpoints

- `GET /health`
- `GET /v1/identity`
- `GET /v1/attestation?nonce=<64 lowercase hex characters>`
- `POST /v1/terms` with `{ "envelope": <encrypted signed terms> }`
- `POST /v1/actions` with `{ "envelope": <encrypted signed action> }`

Responses containing private state are encrypted to the signed per-request reply key.

## Local verification

From `near/`:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For local-only startup, set `ALLOW_UNVERIFIED_DEV_ATTESTATION=true` and never expose that instance as trusted. Production startup rejects development attestation and requires the dstack guest socket.

Production uses `TEE_MAINTENANCE_INTERVAL_MS=15000` by default. Every pass settles all due timeouts and publishes at most one current ledger root. The interval may be set from 1 to 300 seconds; a longer interval reduces gas and timing detail but increases the unanchored rollback window and timeout delay. The worker also checks the dedicated NEAR account at startup and requires exactly one access key: the provisioned function-call key for the configured pool's `anchor_ledger_root` and `withdraw` methods. FullAccess, another account key, another receiver, an empty/unrestricted method list, missing methods, and extra methods all abort startup.

## Trust and privacy limits

The worker protects plaintext only when the confidential platform evidence is independently verified and secrets were provisioned into the approved workload. The encrypted snapshot fallback still trusts availability of the storage operator and the platform/KMS recovery policy. NEAR deposits and withdrawals, their accounts, amounts, and times remain public. The contract does not reveal which deposit funded which private deal, nor a deal's price/collateral split.

Subjective product quality is outside the state machine. A buyer can confirm, both parties can cancel, or the internal scheduler executes the two signed timeout rules: refund the buyer with seller collateral when delivery is missed, and release to the seller when a delivered item is not confirmed in time. There is no middleman who can interpret chat and override those rules.

See [deployment/README.md](deployment/README.md) for the confidential deployment and verification procedure.
