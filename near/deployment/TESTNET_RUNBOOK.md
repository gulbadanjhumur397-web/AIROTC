# AIR OTC NEAR testnet deployment runbook

This runbook deliberately targets NEAR testnet. Every transaction script rejects a
mainnet RPC URL and requires an explicit confirmation value before it signs.

## What requires testnet NEAR

Testnet NEAR is required for account storage, contract deployment, contract calls,
pool deposits, ledger-root anchors, and withdrawals. It has no monetary value. Use
a current NEAR testnet wallet/faucet to fund the accounts. The official NEAR
contract tutorials require a testnet wallet and show testnet deployment through the
NEAR CLI.

Prepare five separate named testnet accounts:

| Account | Purpose | Suggested starting balance |
| --- | --- | ---: |
| owner | Contract administration only | 1 testnet NEAR |
| pool contract | Stores the 174 KB WASM and pooled funds | at least 3 testnet NEAR before user deposits |
| TEE worker | Pays for roots and withdrawals | 1 testnet NEAR |
| buyer | Signs its MCP grant and deposits | demo deposit plus 1 testnet NEAR |
| seller | Signs its MCP grant and deposits | demo deposit plus 1 testnet NEAR |

The scripts recheck actual balances. Faucet availability and limits can change, so
confirm the current route from NEAR's official developer documentation when the
deployment begins.

## 1. Local release gate

From `near/`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:contract:sandbox
pnpm phase9:preflight
```

The preflight prints the local WASM SHA-256. Save it in the evidence bundle.

## 2. Prepare secrets outside Git

Copy `deployment/testnet.env.example` to `near/.secrets/testnet.env`, set mode 600,
and fill it through a password manager or secret manager. The `.secrets` directory
is ignored by Git. Never paste secrets into evidence, tickets, screenshots, or chat.

Generate independent values for the worker encryption key, ledger encryption key,
API database key, API handle secret, each agent signing seed, and each agent box
key. The TEE transaction key and worker encryption key must be provisioned through
the confidential platform's encrypted environment facility.

`prepare-testnet-environment.mjs` may create a local staging transaction key so the
rest of the configuration can be checked before hosting. It marks
`TEE_OPERATIONAL_KEY_PROVISIONED_IN_CVM=false`. Replace that key during confidential
deployment; the lockdown and identity-registration scripts refuse to proceed until
the value is explicitly `true`.

Inside the same confidential secret boundary, derive public values only:

```bash
node scripts/derive-worker-public-key.mjs
node scripts/derive-worker-identity.mjs
```

Record the resulting public key and encryption identity hash. Do not record the
input secrets.

Prepare each agent's hidden signing/encryption environment in a new mode-600 file:

```bash
AGENT_ROLE=BUYER AGENT_SECRET_FILE=near/.secrets/buyer-agent.env node scripts/prepare-agent-env.mjs
AGENT_ROLE=SELLER AGENT_SECRET_FILE=near/.secrets/seller-agent.env node scripts/prepare-agent-env.mjs
```

The signing seed corresponds to that wallet's authorized NEAR key so the worker can
verify off-chain actions. It is equivalent secret key material: keep it inside the
MCP process environment and never include it in a model prompt or tool response.

## 3. Build and identify the confidential workload

Build `tee-worker/Dockerfile`, publish the image, and pin it as
`registry/name@sha256:<digest>`. Configure `TEE_WORKER_IMAGE` in
`tee-worker/deployment/docker-compose.tee.yml`. Obtain the compose/workload hash
from the confidential platform. Mutable tags are forbidden.

The deployment must mount `/var/run/dstack.sock`, persist only the encrypted ledger
snapshot, disable development attestation, and provision all secrets through the
encrypted environment.

## 4. Deploy and initialize the pool contract

The pool account must already exist, be faucet-funded, and have its FullAccess key
available only for deployment. Build the WASM, then run:

```bash
CONFIRM_TESTNET_DEPLOY=DEPLOY_AIROTC_TESTNET node scripts/deploy-contract.mjs
```

The command refuses to overwrite an account that already contains contract code.
It requires the verified worker account, compose measurement hash, and worker
encryption-key hash. Save its JSON output under `near/evidence/`.

The current hackathon pool was initially deployed with a provisional bootstrap
commitment and paused. On 2026-10-25, the verified Phala workload values replaced
that identity through `register-hosted-tee.mjs propose` and delayed activation.
The pool is now unpaused. The public values and transaction references are recorded
in `TESTNET_STATE.md` and `PHALA_TEE_STATE.md`.

## 5. Lock down the worker account

Add the public operational key created inside the confidential secret boundary and
remove the bootstrap FullAccess key in one guarded operation:

```bash
CONFIRM_WORKER_KEY_LOCKDOWN=LOCK_AIROTC_WORKER_KEY node scripts/finalize-worker-key.mjs
```

The script aborts if any unexpected key exists. Success means the account has
exactly one function-call key, restricted to this pool contract and the methods
`anchor_ledger_root` and `withdraw`.

## 6. Start and verify the TEE

Start the digest-pinned confidential workload. Verify a fresh nonce-bound quote as
described in `ATTESTATION.md`. For Phala, save both official quote-verifier
responses, load the public deployment values, and run `pnpm phase9:verify-phala`.
The worker must fail startup if its key scope, pool contract, ledger snapshot, or
anchor state is inconsistent.

Run live inspection:

```bash
pnpm phase9:inspect
```

Save the platform verifier output separately. The inspection script checks the
public contract configuration, sole worker key, exact method restriction, hosted
health endpoints, public state privacy, and local WASM hash.

## 7. Host the API and MCP endpoints

This step waits for the hosting platform. Deploy the privacy API with encrypted
durable storage and HTTPS, then configure separate buyer and seller MCP processes.
The frontend may be hosted afterward without changing the settlement protocol.
Host `demo-api/server.mjs` through HTTPS with the same secret that the seller will
encrypt as the demonstration product. Never expose that value in ordinary host
logs.

## 8. Prepare reusable deposits

For each party, create a deposit secret file with mode 600:

```bash
DEPOSIT_ROLE=BUYER DEPOSIT_SECRET_FILE=near/.secrets/buyer-deposit.env node scripts/prepare-deposit.mjs
DEPOSIT_ROLE=SELLER DEPOSIT_SECRET_FILE=near/.secrets/seller-deposit.env node scripts/prepare-deposit.mjs
```

Call `deposit-testnet.mjs` once per wallet with an amount that covers the expected
deals and gas. The public transaction contains the account, commitment, and amount;
the secret stays off-chain. The agent later calls `pool_claim_deposit` and reuses
the private balance across deals.

## 9. Issue separate wallet-bound MCP tokens

Run `issue-mcp-token.mjs` once for BUYER and once for SELLER. It requests a
challenge, signs the NEP-413 grant using the wallet key, and writes the raw token to
a new mode-600 file. It prints only the token ID and public policy metadata.

## 10. Run the hosted two-agent deal

Build the MCP server and run:

```bash
pnpm phase9:demo
```

The runner starts two independent MCP processes. It proves an intentional
`NO_MATCH`, exact `MATCH`, private balance lock, encrypted delivery, buyer
confirmation, settlement, and two testnet withdrawals. Its evidence contains tool
names, references, commitments, statuses, and transaction hashes, without private
terms, credentials, keys, tokens, or exact private balances.

## 11. Close the release

Run the secret scan again, inspect every recorded transaction in NEAR Explorer,
complete `EVIDENCE_TEMPLATE.md`, follow `JUDGE_REPRODUCTION.md` from a clean
machine, and record `DEMO_SCRIPT.md`. Phase 8's live-chain inspection was completed
against the Phala/NEAR integration run. Phase 7 closes only after the same flow
succeeds through publicly hosted API and MCP services.
