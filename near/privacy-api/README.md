# AIR OTC NEAR privacy API

This service is the untrusted network boundary between wallets/MCP clients and the confidential worker. It stores the complete API state as one AES-256-GCM authenticated ciphertext, stores token hashes instead of tokens, and accepts encrypted envelopes for listings, ticket messages, terms, worker actions, and delivery.

The API never decrypts final terms or worker actions and cannot produce a TEE signature, lock a private balance, confirm delivery, settle a deal, or authorize a withdrawal. Every mutation has a wallet-bound bearer token, an exact scope, an optional buyer/seller role, and a unique request ID. Withdrawal policy accounting is bound to the encrypted signed amount by a domain-separated commitment checked inside the worker.

## Configuration

Copy `.env.example` to a secret-managed runtime environment and set:

- `PRIVACY_API_DATABASE_KEY_B64URL`: 32 random bytes, base64url encoded.
- `PRIVACY_API_HANDLE_SECRET_B64URL`: at least 32 random bytes used only for opaque wallet handles.
- `PRIVACY_API_DATABASE_PATH`: writable encrypted-state file.
- `TEE_WORKER_URL`: confidential worker base URL.
- `NEAR_RPC_URL`: NEAR testnet RPC used to verify the key that signed each NEP-413 token grant.
- `WEB_ORIGIN`: exact allowed browser origin.

No secret belongs in a checked-in `.env` file. Start the compiled service with `pnpm --filter @air-otc/privacy-api build` and `pnpm --filter @air-otc/privacy-api start`.

## Privacy limits

The API process sees authenticated wallet identity, endpoint timing, opaque references, public encryption keys, ciphertext sizes, roles, and withdrawal policy amounts. The on-disk file hides all of these fields at rest. Network metadata remains observable to the host. The TEE and public-chain limits are described in the workspace README.
