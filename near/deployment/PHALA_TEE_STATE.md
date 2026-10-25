# Phala confidential worker state

Verified on 2026-10-25 using fresh nonce-bound worker evidence, Phala's official
quote verifier, RTMR event-log replay, the Phala Cloud API, and NEAR testnet RPC.

## Public deployment identity

| Field | Value |
| --- | --- |
| CVM | `airotc-tee-worker-prod` |
| Platform | Phala Cloud dstack `0.6.1`, production OS, Intel TDX |
| App ID | `04e4341dee051bce7eddb75ec19d12e140714b60` |
| Instance ID | `63d6931afaa9840f8a4938e6977e3b69608ed65f` |
| Worker endpoint | `https://04e4341dee051bce7eddb75ec19d12e140714b60-8080.dstack-pha-prod9.phala.network` |
| Worker account | `airotc-hackathon-worker-20261023-25646d5e.testnet` |
| Image | `ghcr.io/gulbadanjhumur397-web/airotc-tee-worker@sha256:049b534301d792f69950ce14cc46f0dbc9b1c2362c298de2e264c572cd8af445` |
| Compose hash | `bc18c827cf5036f3e48481c07d4f427970dc21cf5eb2bea1557fd2453a9bc828` |
| Docker Compose hash | `ad5082aabbfd0db1047a245346ae41ac8ae7d0de0e151bf3daa771d27951a22e` |
| OS image hash | `ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6` |
| Encryption identity hash | `f837a0c1bfeb9803880ade814de95f99fc74c5551f60be3f0f739e1e68774fcd` |

## Verification result

- The worker returned a fresh quote bound to nonce
  `f02f0cd512aa2ca38a68bacd664ed1e4d88521dc56e9bc015a7877405427bbd9`.
- The computed report data was
  `e894354c6900529a934f10cf3bf9cd2b780d82823a76ecab421d365c6e34ebe4`.
- Phala's official verifier returned `success: true`, `proof_of_cloud: true`, and
  `quote.verified: true` for both the worker quote and platform quote.
- The worker quote report data exactly matched the nonce, worker account,
  encryption key ID, and encryption public key commitment.
- Replaying all measured events reproduced RTMR0, RTMR1, RTMR2, and RTMR3.
- The attested app compose hashes to the registered compose hash and contains the
  exact immutable GHCR digest above.
- The attested production OS hash, app ID, instance ID, and TDX measurements match
  the worker evidence.
- Development attestation is disabled in the attested compose configuration.

Compact verifier IDs:

- Worker quote: `f6cd727f73322ca001c023198ecea3f325c5ad4712831adfe50083f3e9bbe360`
- Platform quote: `930cd5b64264ce018b936b2f0b7088249e3fe86af5cda15d05aba1c31bc8bcec`

## NEAR binding and key custody

The worker account has one access key:

- Public key: `ed25519:5wSt9Zddt6CfJLcJ2JPxkCnohiya46zpWqompXuwgiRG`
- Receiver: `airotc-hackathon-pool-20261023-25646d5e.testnet`
- Methods: `anchor_ledger_root`, `withdraw`
- FullAccess keys: zero

The operational private key was injected through Phala's encrypted environment.
After the worker signed real root-anchor and withdrawal transactions, the local
provisioning copy, local worker encryption key, local ledger key, and diagnostic SSH
key were purged. Active TEE runtime keys now remain only in Phala's encrypted
environment and confidential VM. They are absent from the image, compose file,
repository, public evidence, and logs. The bootstrap FullAccess key was removed
before registration.

Public NEAR transactions:

- Worker identity proposal: `9mve1kYzR3vwbWGHdwV5dZ5b5BYJ27upPnSMgwVSC2Jd`
- Worker identity activation: `8aNPMePkeFuRzHxpFwdy94xVCw4914nRNg9mhbpJ9rAN`
- Pool unpause: `BEVmCYVKo5eJ6HV9qqPbG3dvmo9QTLDfF5kGXuPEhZpS`

After activation, `get_config` reported the compose and encryption hashes above,
`pending_worker: null`, and `paused: false`.

## Reproduction

The ignored evidence directory contains the raw worker response, platform
attestation, compact official verifier responses, key-lockdown record, registration
transactions, and final RPC inspection. With the matching public environment
values loaded, run:

```bash
pnpm --filter @air-otc/shared-types build
pnpm phase9:verify-phala
pnpm phase9:inspect
```

No private key or plaintext deal data is required to verify the public TEE binding.

## Public CI image

The public `near-testnet-hackathon` branch independently rebuilt and published the
worker from commit `9f9f8d7f7bbdc46b27bc9a1523632058dcf72a1c` in GitHub Actions run
`40171838109`:

`ghcr.io/gulbadanjhumur397-web/airotc-tee-worker@sha256:60e57b5c19ad23ff14e594026e6eccec804b65db199cfa8ad5a0aaed400da18c`

That CI image is a reproducible public build artifact. The live CVM intentionally
continues to use the separately attested digest in the deployment identity table.
Replacing the live image would change the measured compose identity and requires a
fresh quote verification plus the contract's delayed worker-identity rotation.

The later integration run produced eight public `anchor_ledger_root` transactions,
ending at sequence `11` and root
`b7c6e34d855740d2eedff3df09302224fc0c1325683aa5df98cc5508a8db66ac`.
This proves the restricted operational key signed real maintenance and
force-anchor calls from the deployed worker.
