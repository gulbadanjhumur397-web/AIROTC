# TEE attestation verification

Attestation is accepted only when a fresh platform proof binds the running workload
and the worker encryption identity to the contract's public policy. A development
attestation is never evidence for Phase 7 or Phase 9.

## Values that must agree

| Value | Source A | Source B |
| --- | --- | --- |
| Worker account | `/v1/identity` | contract `get_config.tee_worker_id` |
| Encryption identity hash | hash of `/v1/identity` | `get_config.tee_encryption_key_hash` |
| Compose/workload hash | verified quote and event log | `get_config.tee_measurement_hash` |
| Image digest | inspected compose document | registry immutable digest |
| Worker access key | encrypted provisioning public output | sole on-chain worker key |
| Method scope | on-chain access-key permission | exactly `anchor_ledger_root`, `withdraw` |

## Verification procedure

1. Generate a cryptographically random 32-byte nonce and encode it as 64 lowercase
   hexadecimal characters.
2. Fetch `/v1/identity` and `/v1/attestation?nonce=<nonce>` through HTTPS.
3. Verify the hardware/platform signature and enforce the current confidential
   platform firmware and TCB policy.
4. Replay the runtime event log according to the platform verifier and recover the
   compose/workload hash.
5. Inspect the exact compose document. Require a digest-pinned worker image, the
   expected socket and encrypted volume, no development-attestation flag, dropped
   Linux capabilities, and no plaintext secrets.
6. Recompute the expected report data. It commits to the caller nonce, worker
   account, encryption key ID, and encryption public key. Require an exact match to
   the verified quote's report data.
7. Compute `workerEncryptionKeyHash(identity)` and compare it to the pool contract.
8. Compare the verified compose hash to the pool contract measurement hash.
9. Query the worker account's access-key list and verify there is exactly one key
   with the expected contract receiver and two-method scope.
10. Save the nonce, quote, verifier version, verifier result, event-log result,
    compose document, image digest, public identity, contract config, and timestamp
    in the evidence bundle.

## Failure behavior

Any missing proof, stale/reused nonce, failed signature, unsupported TCB, event-log
mismatch, compose mismatch, image-tag mutation, identity mismatch, contract-policy
mismatch, or worker-key mismatch must stop private submissions. Health status alone
does not establish trust. Descriptive `Info` fields inside an unverified response do
not establish trust.

## Key custody claim

The repository proves that the worker refuses a FullAccess key, extra account keys,
the wrong receiver, or the wrong method set. Live evidence must separately prove
that the operational private key was delivered only through the confidential
platform's encrypted environment and was never placed in Git, an image layer, a
compose file, ordinary host environment, build argument, log, or evidence file.
