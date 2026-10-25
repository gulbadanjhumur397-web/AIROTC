# Current NEAR testnet state

Verified on 2026-10-25 against NEAR testnet and the live Phala confidential VM.

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
- Verified worker proposal: `9mve1kYzR3vwbWGHdwV5dZ5b5BYJ27upPnSMgwVSC2Jd`
- Verified worker activation: `8aNPMePkeFuRzHxpFwdy94xVCw4914nRNg9mhbpJ9rAN`
- Pool unpause: `BEVmCYVKo5eJ6HV9qqPbG3dvmo9QTLDfF5kGXuPEhZpS`
- Pool state: **unpaused**
- Pool liability after deposits and three small test withdrawals: `1994977000000000000000000`

## Verified confidential worker

- Endpoint: `https://04e4341dee051bce7eddb75ec19d12e140714b60-8080.dstack-pha-prod9.phala.network`
- Image: `ghcr.io/gulbadanjhumur397-web/airotc-tee-worker@sha256:049b534301d792f69950ce14cc46f0dbc9b1c2362c298de2e264c572cd8af445`
- Compose hash: `bc18c827cf5036f3e48481c07d4f427970dc21cf5eb2bea1557fd2453a9bc828`
- Encryption identity hash: `f837a0c1bfeb9803880ade814de95f99fc74c5551f60be3f0f739e1e68774fcd`
- Worker public key: `ed25519:5wSt9Zddt6CfJLcJ2JPxkCnohiya46zpWqompXuwgiRG`
- Worker key permission: pool contract only; `anchor_ledger_root`, `withdraw`
- FullAccess or additional worker keys: **none**

The fresh worker and platform Intel TDX quotes passed Phala's official verifier.
The nonce binding, report data, production OS measurement, RTMR event-log replay,
compose hash, immutable image digest, encryption identity, and NEAR access key were
all independently cross-checked. See `PHALA_TEE_STATE.md` for the public record.

## Reusable testnet deposits

- Buyer attached one testnet NEAR:
  `CocdYnM967rUMuCaLi2aWLsUwYiZXSa78HU48TBf7mFu`
- Seller attached one testnet NEAR:
  `6CXARjy7oztajKeuvm9UbAj3pwvaVibBEiTURATVSPe5`
- Net credited liability after contract storage charges:
  `1994980000000000000000000` yoctoNEAR

The two deposit secrets remain in separate ignored mode-600 files. Their public
commitments and amounts are visible on NEAR, while later private balance changes
remain inside the worker ledger and are represented publicly only by batched roots.

## Real Phala/NEAR integration result

Two independent MCP processes completed the full deal flow through a locally run
privacy API connected to the production Phala worker and NEAR testnet contract:

- intentional mismatch: `WAITING_FOR_COUNTERPARTY` then `NO_MATCH`
- exact terms: `MATCH`, deal `FUNDED`
- encrypted delivery: buyer decrypted and successfully used the API credential
- buyer confirmation: deal `COMPLETED`
- final buyer withdrawal: `8uoGtyWqLH9gYEXMgzzRrMqN2aacpd9YjQ21cgrSSsdJ`
- final seller withdrawal: `8fcpTPbNLbgE6sjyrQKeqKDVvCkYMPkxFaYCs5DvE7aK`
- final ledger sequence: `11`
- final root: `b7c6e34d855740d2eedff3df09302224fc0c1325683aa5df98cc5508a8db66ac`

The live Explorer audit decoded 13 transactions: two deposits, eight ledger-root
anchors, and three withdrawals. The extra withdrawal was a small buyer withdrawal
that NEAR completed after the original 15-second API timeout; its hash is
`3znRQLshkjGerskr34Y2LAF34WVhiv1SdBHfmQatCRAe`. The timeout was increased before
the successful final run. No ticket, deal, terms, price, collateral, delivery,
product, credential, or private-balance field appeared in public arguments, events,
or contract configuration.

## Remaining live work

1. Host the privacy API, MCP server, demo API, and supporting database.
2. Configure their public URLs to use the worker endpoint and testnet contract.
3. Create fresh wallet-bound MCP grants from the hosted API. The existing deposits
   are already claimed in the worker's persistent private ledger.
4. Repeat the already-passing two-agent flow through the publicly hosted services.
5. Save the hosted-run evidence and video.

Secret keys are stored only in ignored mode-600 files under `near/.secrets/` and are
not included in this record or the public TEE evidence.
