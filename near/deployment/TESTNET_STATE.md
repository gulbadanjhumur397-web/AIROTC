# Current NEAR testnet state

Verified on 2026-10-24 against NEAR testnet.

## Public accounts

| Role | Account |
| --- | --- |
| Owner | `airotc-hackathon-owner-20261023-25646d5e.testnet` |
| Pool contract | `airotc-hackathon-pool-20261023-25646d5e.testnet` |
| TEE worker | `airotc-hackathon-worker-20261023-25646d5e.testnet` |
| Buyer demo wallet | `airotc-hackathon-buyer-20261023-25646d5e.testnet` |
| Seller demo wallet | `airotc-hackathon-seller-20261023-25646d5e.testnet` |

## Contract deployment

- WASM SHA-256: `db42e4388c3b6603f13a31b8a06a132ac2fb7a44019eaa178e49345fda7c7fd5`
- Deploy transaction: `HdtMh7AfnUcYh7AW9sKVmmNF2H7aGEvwZ84PnCApvrBw`
- Initialize transaction: `A84u4kKxiDyDYM5zzZqzNccDYjfx1MKt7o2b1SaQ3QFJ`
- Pause transaction: `HckYftByhoPaKkHcGwfWGqgkZ9uvMjvob48Zu4uNund6`
- Pool state: **paused**
- Pool liability: `0`

The current measurement is a provisional bootstrap commitment. It is not presented
as NEAR Confidential Compute attestation. The contract is deliberately paused, the
worker retains its single bootstrap FullAccess key, and user deposits are not
accepted in this state.

## Required transition after hosting

1. Publish and deploy the digest-pinned worker image to the supplied NEAR
   confidential-compute platform.
2. Verify a fresh nonce-bound quote, the runtime event log, compose hash, image
   digest, worker encryption identity, and worker account.
3. Generate or provision a fresh operational key through the CVM encrypted
   environment, replace the local staging key, and set
   `TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM=true`. The local staging key is not a
   production claim and must not be activated.
4. Run `finalize-worker-key.mjs` to leave exactly one function-call key restricted
   to `anchor_ledger_root` and `withdraw`.
5. Replace the provisional values in the ignored environment file with the verified
   compose and encryption-identity hashes, set `TEE_IDENTITY_PROVISIONAL=false`,
   `TEE_ATTESTATION_VERIFIED=true`, and provide the digest-pinned image reference.
6. Run `register-hosted-tee.mjs propose`, wait for the on-chain rotation delay, then
   run `register-hosted-tee.mjs activate`. The activation command verifies the exact
   worker key and identity before unpausing the pool.
7. Run the live inspection, reusable deposits, MCP grants, and two-agent test.

Secret keys are stored only in ignored mode-600 files under `near/.secrets/` and are
not included in this record.
