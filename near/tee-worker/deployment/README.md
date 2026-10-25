# Confidential worker deployment

The production deployment is a digest-pinned container inside a Phala Cloud dstack confidential VM. The workload reads evidence from `/var/run/dstack.sock`, and a verifier checks the platform proof, runtime event log, compose hash, and expected image digest.

`docker-compose.phala.yml` is the deployed Phala workload manifest;
`docker-compose.tee.yml` remains the provider-neutral template. The production
manifest mounts the guest-agent socket, persists only an authenticated encrypted
ledger snapshot, uses a read-only root filesystem, drops Linux capabilities, and
rejects development attestation.

## Build and pin the image

Build `near/tee-worker/Dockerfile`, publish it to the hackathon registry, record the immutable `sha256` digest, and set `TEE_WORKER_IMAGE` to the full digest reference. Do not deploy a mutable tag. The digest reference becomes part of the compose document and therefore part of the attested compose hash.

## Provision secrets

Generate independent 32-byte values for the request-encryption key and ledger-encryption key. Provision those values and the NEAR testnet function-call key through the confidential platform's encrypted environment mechanism after reviewing the deployment measurement. Never put them in the compose file, repository, build arguments, image layers, or ordinary host logs.

Use a dedicated NEAR account for the worker. Add a function-call key scoped exactly to the pool contract methods `anchor_ledger_root` and `withdraw`, then delete the account's bootstrap FullAccess key. Worker startup derives the public key from the provisioned secret, requires it to be the account's only access key, reads its on-chain permission, and aborts on any mismatch. The contract's worker account and public compose hash are registered only after verification.

Set `TEE_MAINTENANCE_INTERVAL_MS` to the root-anchor and timeout-check interval (15 seconds by default). One pass settles every timeout then anchors one current root, which limits on-chain timing detail and gas use. Withdrawals bypass the wait and force-anchor their current root. The configured interval is also the maximum normal timeout delay and unanchored rollback window, so record it with the deployment evidence.

## Verify before sending private data

1. Fetch `/v1/identity` and create a fresh random 32-byte lowercase-hex nonce.
2. Fetch `/v1/attestation?nonce=<nonce>`.
3. Recompute `binding.reportData` with `attestationReportData` from this package. It commits to the nonce, worker account, encryption key ID, and encryption public key.
4. Remove the four-byte dstack framing prefix from `evidence.attestationHex`, submit the raw quote to Phala's verifier, and require `success`, `proof_of_cloud`, and `quote.verified` to all be true. Require the quote `reportdata` to equal the computed 32-byte binding followed by 32 zero bytes.
5. Require the verified compose hash to equal `evidence.composeHash`, then inspect the exact compose document and its digest-pinned worker image.
6. Compute `workerEncryptionKeyHash(identity)` from `@air-otc/shared-types` and require it to equal the `tee_encryption_key_hash` registered in the NEAR pool contract.
7. Require the compose hash to equal the `tee_measurement_hash` registered in the NEAR pool contract.
8. Inspect the worker account's public access-key list and require exactly one key: the same provisioned public key, pool receiver, and exact two-method scope that startup enforces.
9. Encrypt terms only after every check passes.

`issuedAt` is response metadata and is not a security clock. Freshness comes from the caller nonce inside verified `report_data`. `Info` fields alone are not proof; the platform attestation and event-log replay must confirm them.

## Platform access boundary

The deployed public identity and verification result are recorded in
`near/deployment/PHALA_TEE_STATE.md`. Raw quote, certificate, event-log, and
transaction responses stay in ignored `near/evidence/` files. Re-run
`pnpm phase9:verify-phala` whenever the image, compose document, OS, app, instance,
or worker encryption identity changes.
