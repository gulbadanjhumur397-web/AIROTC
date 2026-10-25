# AIR OTC private pool contract

This Rust contract is the public settlement layer for the AIR OTC NEAR testnet design. It stores pooled deposits, a commitment for each deposit, the latest private-ledger root, and finalized withdrawal records. Deal IDs, counterparties, prices, collateral allocations, terms, and delivery evidence remain inside the confidential worker.

The contract cannot hide a user's public deposit or withdrawal transaction. Pooling prevents the contract from publishing a direct deposit-to-deal or price-to-collateral mapping.

## Trust and authorization

- Anyone can deposit native NEAR under a SHA-256 commitment scoped to their depositor account, so another account cannot reserve the same commitment first.
- Only the configured TEE worker account can anchor a ledger root or start a withdrawal.
- Withdrawals must use the current root, expire within 24 hours, and stay under the per-withdrawal and rolling-window limits.
- Withdrawal IDs are replay protected. A failed transfer restores pool liability and permits at most three exact retries.
- Worker rotation has an owner-configured delay. The proposed account, attested workload measurement, and encryption-identity hash are public before activation.
- Emergency recovery pauses the pool immediately and applies a fixed seven-day delay before a replacement worker can be installed. The pool remains paused until the owner reviews and resumes it.
- The owner can pause deposits, root updates, and withdrawals in an emergency.

All `u64` JSON arguments and results are decimal strings. All native-token amounts are decimal yoctoNEAR strings.

## Build and verify

From `near/escrow-contract`, with Rust and `wasm32-unknown-unknown` installed:

```bash
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
pnpm run build
pnpm run test:sandbox
```

The local pinned-toolchain WASM output is `build/air-otc-pool.wasm`. The
NEP-330 build metadata in `Cargo.toml` pins the SourceScan container by digest;
run `pnpm run build:reproducible` on a machine with Docker for the independently
reproducible artifact in `build/reproducible`.

## Testnet initialization

Deploy the WASM to a NEAR testnet account, then call `new` once:

```json
{
  "config": {
    "owner_id": "owner.testnet",
    "tee_worker_id": "worker.testnet",
    "tee_measurement_hash": "<64 lowercase hex characters>",
    "tee_encryption_key_hash": "<workerEncryptionKeyHash output from the verified identity>",
    "min_deposit": "1",
    "max_withdrawal": "100000000000000000000000000",
    "max_withdrawal_per_window": "500000000000000000000000000",
    "withdrawal_window_ns": "60000000000",
    "rotation_delay_ns": "3600000000000"
  }
}
```

The worker account, `tee_measurement_hash`, and `tee_encryption_key_hash` must be copied from independently verified deployment evidence before accepting testnet deposits. Browser and MCP clients query these final on-chain values and refuse to encrypt terms or actions to a substituted worker key.
