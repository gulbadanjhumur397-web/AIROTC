# AIROTC NEAR Private Agent Escrow Roadmap

## 1. Goal

Build a hackathon-ready marketplace where independent AI agents can discover, negotiate, buy, and sell digital products through MCP while keeping the commercially sensitive parts of a deal private.

The product will run on NEAR testnet and use a custom deterministic worker inside NEAR Confidential Compute. The worker will compare encrypted structured terms and maintain the private escrow ledger. It will not use an LLM, NLP, a human middleman, or subjective language interpretation to approve agreements or release funds.

The finished demonstration must show two independent agents completing a real end-to-end deal with separate MCP credentials and NEAR testnet accounts.

## 2. Hackathon scope

### Reused foundation

The project will reuse suitable parts of the existing AIROTC repository:

- Marketplace and listing concepts
- Ticket and messaging foundation
- API server structure
- MCP server structure
- Frontend components that are chain-independent
- Existing agent examples where their permissions can be made safe

### New hackathon work

The submission README must clearly identify the work built for the NEAR hackathon:

- NEAR testnet shared-pool contract
- NEAR wallet and testnet integration
- Deterministic NEAR Confidential Compute worker
- TEE attestation and workload verification
- Encrypted structured terms protocol
- Exact two-party terms matching
- Encrypted ticket messages
- Encrypted digital delivery
- Private pooled ledger
- Scoped and wallet-bound MCP authentication
- Two-agent end-to-end test harness
- Privacy and security evidence for judges

### Explicitly excluded

- NLP agreement detection
- An LLM middleman
- Human arbitration in the MVP
- Mainnet deployment or real funds
- NEAR Intents settlement in the testnet MVP
- Custom zero-knowledge circuits
- Claims that deposits or withdrawals are invisible on public NEAR testnet

## 3. Product principles

1. **Deterministic authorization:** only signed structured data controls escrow state.
2. **Private by default:** plaintext terms, chat, balances, and delivery data stay off the public chain.
3. **Least privilege:** every MCP token is bound to one identity, one wallet, and explicit scopes.
4. **No model-held keys:** agents choose actions, but wallet and encryption keys remain in trusted signing components.
5. **Honest privacy claims:** public testnet deposits and withdrawals remain observable.
6. **Recoverable operation:** a TEE outage must not permanently trap test funds.
7. **Judge reproducibility:** the main flow must be repeatable from documented steps.

## 4. Privacy model

### Private data

The following information must remain encrypted or exist only inside the verified TEE:

- Ticket messages
- Exact negotiated price
- Buyer collateral
- Seller collateral
- Final private terms
- Product secrets and API keys
- Delivery contents
- Individual pool balances
- Locked balances
- Mapping between a ticket and pool movements
- Settlement calculations

### Public data

The following information may be visible:

- Public listing metadata chosen by the seller
- Contract address and code
- Pool deposits and withdrawals
- Depositing and receiving testnet addresses
- Deposit and withdrawal amounts
- Transaction timestamps
- Opaque commitments and ledger roots
- Registered TEE account or workload identifier
- Used withdrawal nonces
- Contract pause and upgrade events

### Privacy limitations

NEAR testnet is a public blockchain. A public observer can see deposits into and withdrawals from the shared pool. The MVP reduces deal linkage through:

- One shared pool instead of one escrow account per deal
- Internal balances that can be reused across multiple deals
- Fixed or recommended deposit denominations
- Random public commitments with no ticket identifier
- Delayed withdrawals
- Optional one-time testnet accounts
- Batched private-ledger root anchoring

The MVP must never claim that deposits, withdrawals, addresses, timestamps, or transferred amounts are completely hidden.

## 5. High-level architecture

```text
Buyer Agent                         Seller Agent
     |                                   |
     | separate MCP token and identity   |
     v                                   v
+------------------------------------------------+
|                 MCP Server                     |
| scoped tools, wallet binding, policy checks    |
+----------------------+-------------------------+
                       |
                       v
+------------------------------------------------+
|                  API Server                    |
| listings, ciphertext, commitments, references |
+----------------------+-------------------------+
                       |
          encrypted submissions and delivery
                       |
                       v
+------------------------------------------------+
|        NEAR Confidential Compute Worker        |
| signature checks, exact matching, private      |
| ledger, locking, settlement, authorization     |
+----------------------+-------------------------+
                       |
          signed calls / authorized actions
                       |
                       v
+------------------------------------------------+
|             NEAR Testnet Pool Contract         |
| deposits, withdrawals, replay protection,      |
| TEE identity, roots, pause and recovery        |
+------------------------------------------------+
```

## 6. Core deal lifecycle

### 6.1 Account and agent setup

1. A user connects a NEAR testnet wallet.
2. The platform records the public account identity.
3. The user creates an MCP token with selected scopes and limits.
4. The MCP token is permanently bound to that platform identity and wallet.
5. The private wallet key remains outside the model context.
6. The client verifies the expected TEE attestation before sending private data.

### 6.2 Pool deposit

1. The user generates a random deposit secret locally.
2. The client derives a deposit commitment.
3. The wallet deposits testnet funds into the shared contract with the commitment.
4. The TEE observes or verifies the finalized deposit.
5. The user proves knowledge of the deposit secret through an encrypted channel.
6. The TEE credits the user's private internal balance.

Deposits are public, but the internal balance and future deal association are private.

### 6.3 Listing and discovery

1. The seller agent creates a public listing through MCP.
2. The listing exposes only metadata the seller chooses to publish.
3. The exact final price may be omitted, shown as a range, or negotiated privately.
4. The buyer agent searches and filters listings through MCP.
5. The buyer opens a private ticket with the seller.

### 6.4 Encrypted negotiation

1. Buyer and seller exchange end-to-end encrypted ticket messages.
2. The API stores ciphertext, sender pseudonym, timestamp, and ciphertext hash.
3. Negotiation can use natural language because it does not control the escrow.
4. Each side independently prepares a structured final-terms object.

### 6.5 Final terms submission

The versioned structured terms object will contain at least:

```json
{
  "version": 1,
  "ticketId": "private-random-id",
  "buyerId": "buyer identity",
  "sellerId": "seller identity",
  "assetDescriptionHash": "sha256 commitment",
  "currency": "NEAR_TESTNET",
  "priceAtomic": "string integer",
  "buyerCollateralAtomic": "string integer",
  "sellerCollateralAtomic": "string integer",
  "fundingDeadlineNs": "string integer",
  "deliveryDeadlineNs": "string integer",
  "confirmationDeadlineNs": "string integer",
  "sellerTimeoutRule": "REFUND_BUYER_WITH_SELLER_COLLATERAL",
  "buyerTimeoutRule": "AUTO_RELEASE_TO_SELLER",
  "nonce": "unique random value",
  "expiresAtNs": "string integer"
}
```

For each submission:

1. The client canonicalizes the object using one documented encoding.
2. The party signs the canonical bytes.
3. The client encrypts the object and signature to the verified TEE public key.
4. The TEE verifies the signature, identity, nonce, and expiry.
5. The TEE compares the two canonical term objects exactly.
6. A mismatch returns `NO_MATCH` without revealing the other party's terms.
7. An exact match creates the private deal and a public-safe commitment.

No LLM or NLP participates in this decision.

### 6.6 Private funding lock

After an exact match:

1. The TEE checks that the buyer has `price + buyer collateral` available.
2. The TEE checks that the seller has `seller collateral` available.
3. The TEE atomically moves those values from available to locked balances.
4. The TEE records the private deal state.
5. A batched ledger commitment can be anchored on-chain without publishing deal values.

### 6.7 Encrypted delivery

1. The buyer provides a delivery encryption public key.
2. The seller encrypts the product or a symmetric file key for the buyer.
3. The encrypted payload is uploaded to configured storage.
4. The API stores only ciphertext and metadata required for retrieval.
5. The TEE records the delivery hash and timestamp.
6. The buyer downloads, decrypts, and verifies the product.

### 6.8 Settlement

The MVP supports deterministic outcomes only:

#### Buyer accepts

- Seller receives the price in the private ledger.
- Buyer collateral returns to the buyer's available balance.
- Seller collateral returns to the seller's available balance.
- Deal status becomes `COMPLETED`.

#### Seller misses the delivery deadline

- Buyer price and buyer collateral are unlocked.
- The signed MVP seller-timeout rule awards seller collateral to the buyer.
- Deal status becomes `SELLER_TIMEOUT`.

#### Buyer is inactive after recorded delivery

- The signed buyer-timeout rule automatically releases the price and seller collateral to the seller after the confirmation deadline.
- Deal status becomes `AUTO_RELEASED`.

#### Mutual cancellation

- Both parties sign the same cancellation object.
- Locked funds are returned according to the matched terms.
- Deal status becomes `CANCELLED`.

#### Subjective dispute

The MVP has no middleman and cannot reliably judge whether an arbitrary digital product is useful or high quality. A subjective dispute can only:

- Remain frozen until both parties sign a resolution, or
- Follow the timeout rule they accepted before funding.

The UI and README must disclose this limitation.

### 6.9 Withdrawal

1. A user requests a withdrawal from the private balance.
2. The TEE checks available balance and policy limits.
3. The TEE creates a unique, expiring withdrawal authorization.
4. The contract verifies the authorized TEE caller or signature and unused nonce.
5. The contract transfers testnet funds to the requested account.
6. The withdrawal is public but is not labeled with a ticket or deal ID.

## 7. NEAR testnet contract

### Required state

- Owner or governance account
- Approved TEE worker account or verification key
- Approved TEE workload measurement or policy commitment
- Approved TEE request-encryption identity hash
- Pause state
- Used authorization nonces
- Latest ledger root and sequence number
- Emergency recovery configuration
- Maximum single withdrawal and rate limits

### Required methods

- `init(...)`
- `deposit(commitment)`
- `withdraw(recipient, amount, nonce, expiry, authorization)`
- `anchor_ledger_root(root, sequence)`
- `propose_tee_worker(account, measurement, encryption_key_hash)`
- `activate_tee_worker()`
- `set_limits(...)`
- `pause()`
- `unpause()`
- `begin_emergency_recovery(...)`
- Read-only configuration and nonce queries

### Contract security requirements

- Atomic-unit integer amounts only
- Checked arithmetic
- Strict caller verification
- Nonce replay protection
- Expiring authorizations
- Withdrawal limits
- Pause switch
- Delayed TEE-key rotation
- Delayed emergency recovery
- No plaintext deal fields in storage, arguments, logs, or panic messages
- No unbounded collections in transaction paths
- Unit tests for every state transition
- NEAR sandbox integration tests before testnet deployment

## 8. Deterministic TEE worker

### Responsibilities

- Expose health, encryption-key, and attestation endpoints
- Decrypt party submissions inside the TEE
- Verify NEAR-compatible signatures
- Enforce identity, role, nonce, and expiry rules
- Canonicalize and compare structured terms
- Maintain the encrypted private ledger
- Lock and unlock internal balances atomically
- Record delivery commitments
- Apply confirmation and timeout rules
- Produce withdrawal authorizations
- Produce periodic ledger roots
- Emit redacted operational logs

### Prohibited behavior

- Calling an LLM for agreement or settlement
- Interpreting conversational messages
- Guessing missing term fields
- Automatically changing submitted terms
- Logging plaintext terms, products, balances, or delivery data
- Returning one party's private submission to the other

### Attestation flow

1. Build the worker from a pinned source revision.
2. Produce a reproducible image or attested build artifact where supported.
3. Deploy it in NEAR Confidential Compute.
4. Obtain the platform attestation report.
5. Verify the platform certificate chain and workload measurements.
6. Register the approved worker account, workload measurement, and request-encryption identity hash with the testnet contract.
7. Have clients read that final on-chain policy and verify a fresh nonce-bound attestation before encryption.
8. Document exactly which property the attestation proves.

The project must not claim that a raw VM attestation proves application code identity unless the workload measurement or attested-build chain actually binds the deployed code.

### Persistent private state gate

Before finalizing storage, confirm the current NEAR Confidential Compute support for:

- Persistent encrypted disks
- Attested secret provisioning
- Workload-bound keys
- Snapshot recovery
- Key rotation

If native sealing is not available, the hackathon fallback is:

- Ciphertext-only external database
- Ledger encryption key provisioned after attestation
- Encrypted authenticated snapshots
- Contract-anchored ledger roots
- Delayed emergency refund process
- Clear documentation of the operator and recovery trust assumptions

## 9. Encrypted ticket and delivery service

### Ticket encryption

- Each ticket receives a random room key.
- The room key is wrapped separately for buyer and seller public keys.
- Message encryption uses an authenticated encryption construction.
- Every message includes ticket ID, sender, sequence number, and nonce in authenticated data.
- The server rejects duplicate nonces and invalid sequences.
- The database stores ciphertext only.

### Delivery encryption

- Small secrets can be encrypted directly to the buyer.
- Large files use a random symmetric key.
- The file is encrypted with authenticated encryption.
- The symmetric key is encrypted for the buyer.
- The delivery hash is bound to the private deal.
- Download URLs are short-lived and authorization checked.

### Logging policy

Logs may include:

- Request ID
- Opaque user or ticket reference
- Status code
- Latency
- Ciphertext size

Logs must exclude:

- Plaintext messages
- Structured private terms
- Exact private balances
- API keys and products
- Wallet private keys
- MCP bearer tokens
- Encryption keys

## 10. MCP server

### Identity and authorization changes

- Bind every token to one immutable user ID and NEAR account.
- Persist and enforce requested scopes.
- Remove delegated-wallet header bypasses.
- Reject any requested wallet that differs from the token binding.
- Add expiration, revocation, and rotation.
- Hash stored tokens.
- Apply per-tool rate limits.
- Add configurable spending and withdrawal limits.
- Require fresh user authorization for high-value actions outside the demo profile.

### MCP tools

#### Marketplace

- `list_products`
- `get_product`
- `create_listing`
- `update_listing`
- `close_listing`

#### Tickets

- `open_ticket`
- `get_ticket`
- `send_encrypted_message`
- `list_ticket_events`

#### Privacy and terms

- `get_tee_identity`
- `verify_tee_attestation`
- `submit_encrypted_terms`
- `get_terms_match_status`

#### Pool and escrow

- `get_deposit_commitment`
- `deposit_to_pool`
- `get_private_balance`
- `get_private_deal_status`
- `request_mutual_cancel`
- `request_withdrawal`

#### Delivery

- `submit_encrypted_delivery`
- `get_encrypted_delivery`
- `confirm_delivery`

### MCP key isolation

- The language model never receives raw wallet or encryption private keys.
- A signing component validates each requested operation against token policy.
- Buyer tools cannot perform seller-only actions.
- Seller tools cannot confirm delivery as the buyer.
- Tool responses redact sensitive data unless the caller is authorized to receive it.

## 11. API and database changes

### Financial types

- Replace floating-point price and collateral fields.
- Use atomic-unit decimal strings at API boundaries.
- Use integers or exact database decimals internally.
- Validate upper bounds before conversion.

### Public API data

- Listing metadata
- Public account identifiers where required
- Ciphertext envelopes
- Opaque commitments
- Public transaction references
- TEE identity and attestation metadata

### Private data handling

- Do not send plaintext final terms through the ordinary API.
- Do not store decrypted ticket messages.
- Do not store decrypted delivery contents.
- Do not mirror the TEE's private balance ledger in plaintext.
- Return private balance information only through an encrypted authenticated session.

### Database migrations

- Add versioned ciphertext envelope tables.
- Add token scope and wallet-binding fields.
- Add token revocation and expiry fields.
- Add opaque deal and commitment references.
- Add replay nonce records where needed outside the contract.
- Preserve legacy Solana data without including it in the NEAR runtime path.

## 12. Frontend

### Required screens

- NEAR testnet wallet connection
- Marketplace browse and search
- Create and manage listing
- Pool deposit
- Private available and locked balance
- Encrypted ticket chat
- Structured final-terms editor
- Terms-match result
- Delivery upload and retrieval
- Buyer confirmation
- Mutual cancellation
- Timeout status
- Withdrawal
- TEE identity and verification status
- Privacy information panel

### Required user explanations

The UI must clearly show:

- Which data is public
- Which data is encrypted
- Which data is processed by the TEE
- That deposits and withdrawals are public
- That exact terms control settlement
- That ticket conversation does not control settlement
- Which timeout rule will run
- That subjective arbitration is unavailable in the MVP

### Transaction safety

- Show exact action, amount, account, and network before signing.
- Display `NEAR testnet` prominently.
- Reject mainnet configuration in the hackathon build.
- Prevent duplicate submissions while transactions are pending.
- Provide transaction links after confirmation.

## 13. Repository layout

Recommended final structure:

```text
AIROTC/
├── api-server/                 # Reused and adapted API
├── frontend/                   # Reused and adapted frontend
├── mcp/
│   └── air-otc-server/         # Secured MCP server
├── near/
│   ├── escrow-contract/        # NEAR shared-pool contract
│   ├── tee-worker/             # Deterministic confidential worker
│   ├── shared-types/           # Canonical terms and envelopes
│   └── deployment/             # Testnet and TEE deployment files
├── tests/
│   ├── contract/               # Contract tests
│   ├── integration/            # API/MCP/TEE integration
│   ├── privacy/                # Public leakage checks
│   ├── security/               # Auth, replay and tamper tests
│   └── external-agents/        # Two-agent E2E harness
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PRIVACY_MODEL.md
│   ├── THREAT_MODEL.md
│   ├── TEE_ATTESTATION.md
│   ├── TESTNET_DEPLOYMENT.md
│   └── JUDGE_DEMO.md
├── ROADMAP.md
└── README.md
```

The legacy Solana program and middleman code may remain for provenance, but they must be excluded from the NEAR deployment and clearly marked as legacy. The middleman service must not run in the new application stack.

## 14. Implementation phases

### Phase 0: Architecture and privacy freeze

Tasks:

- [ ] Confirm MVP asset and timeout behavior.
- [ ] Freeze the canonical final-terms schema.
- [ ] Document public and private fields.
- [ ] Document trust assumptions and privacy limitations.
- [ ] Confirm NEAR Confidential Compute access.
- [ ] Confirm attestation and persistent-secret capabilities.
- [ ] Decide the encrypted database and object-storage providers.
- [ ] Define emergency recovery behavior.

Exit criteria:

- Architecture, privacy model, and state machine are documented.
- No unresolved question can change the contract interface materially.

### Phase 1: Shared types and cryptographic envelopes

Tasks:

- [x] Create shared versioned term types.
- [x] Implement canonical encoding.
- [x] Implement signature envelopes.
- [x] Implement encrypted submission envelopes.
- [x] Add nonce and expiry validation.
- [x] Create cross-language test vectors.
- [x] Pin identical hashes in the shared package, TEE, and Rust contract tooling; later frontend, MCP, and API phases must consume this package and fixture.

Exit criteria:

- Buyer and seller independently produce the same commitment from the same terms.
- One-byte differences produce `NO_MATCH`.
- Tampered messages and replayed nonces are rejected.

### Phase 2: NEAR contract

Tasks:

- [x] Implement the shared-pool contract using the stable NEAR Rust SDK.
- [x] Implement deposits and commitment events.
- [x] Implement TEE-authorized withdrawals.
- [x] Implement nonce replay protection.
- [x] Implement root anchoring.
- [x] Implement limits, pause, rotation, and emergency recovery.
- [x] Add unit and sandbox tests.
- [x] Add digest-pinned NEP-330 reproducible-build metadata and verify byte-identical local WASM builds.

Exit criteria:

- All contract tests pass.
- The compiled contract deploys to NEAR sandbox.
- Unauthorized, expired, replayed, and excessive withdrawals fail.

### Phase 3: Deterministic TEE worker

Tasks:

- [x] Implement identity and attestation endpoints.
- [x] Implement encrypted term submission.
- [x] Implement signature verification.
- [x] Implement exact terms matching.
- [x] Implement private account and deal ledgers.
- [x] Implement atomic balance locking.
- [x] Implement delivery, confirmation, cancellation, and timeout state transitions.
- [x] Run timeout checks from an internal worker schedule so no agent call is required.
- [x] Implement withdrawal authorization.
- [x] Implement encrypted snapshots, anchored rollback detection, and recovery.
- [x] Batch ledger roots on a bounded interval and force-anchor before withdrawals.
- [x] Require the dedicated worker account to contain only the provisioned key scoped exactly to the pool's `anchor_ledger_root` and `withdraw` methods.
- [x] Add redacted structured logging.
- [x] Build the worker container definition and digest-required NEAR Confidential Compute deployment manifest. Image publication and live deployment are Phase 9.

Exit criteria:

- The worker deployment artifact produces nonce-bound dstack attestation evidence; live verification is completed during Phase 9 deployment.
- Plaintext private data does not leave the worker.
- Restart and snapshot recovery tests pass.

### Phase 4: API and encrypted storage

Tasks:

- [x] Add encrypted ticket storage.
- [x] Add encrypted delivery storage.
- [x] Add opaque deal references.
- [x] Migrate financial values away from floating point.
- [x] Remove middleman calls from the NEAR path.
- [x] Add TEE proxy endpoints without plaintext termination.
- [x] Add rate limits and audit-safe logs.

Exit criteria:

- Database inspection reveals no plaintext messages, terms, balances, or products.
- The API cannot independently approve or settle a deal.

### Phase 5: MCP security and tools

Tasks:

- [x] Fix token-scope enforcement.
- [x] Bind tokens to immutable wallet identities.
- [x] Remove delegated-wallet bypass behavior.
- [x] Implement NEAR marketplace, ticket, terms, pool, delivery, and withdrawal tools.
- [x] Add role checks and spending policies.
- [x] Add token rotation and revocation.
- [x] Add agent-safe error messages with no secret leakage.
- [x] Make reusable private-balance checks and pre-funding the documented default agent flow.

Exit criteria:

- Separate buyer and seller tokens cannot impersonate each other.
- Private keys never appear in model-visible MCP responses.
- Each high-impact MCP tool has an authorization and replay test.

### Phase 6: Frontend

Tasks:

- [x] Integrate NEAR testnet wallet support.
- [x] Build pool balance and deposit flows.
- [x] Build encrypted ticket chat.
- [x] Build structured terms review and signing.
- [x] Display TEE verification state.
- [x] Build encrypted delivery and confirmation.
- [x] Build withdrawal flow.
- [x] Add clear privacy and timeout explanations.

Exit criteria:

- A human can complete the same deal flow as an agent.
- The browser does not log secrets or send plaintext private fields to the API.

### Phase 7: Two-agent end-to-end system

Hosted-only completion gate: keep this phase open until the Phase 9 services are
hosted and two independent agents complete the entire flow against the real NEAR
testnet contract and verified confidential-compute deployment. A local simulated
pair does not satisfy this phase.

Tasks:

- [x] Create independent buyer and seller agent profiles.
- [ ] Give each agent a separate MCP token and testnet account. Separate funded accounts exist; hosted wallet-signed MCP grants remain.
- [x] Add deterministic role prompts and spending limits.
- [x] Create a demonstration API-key product.
- [ ] Implement the autonomous happy-path scenario.
- [x] Implement a deterministic scripted fallback.
- [ ] Capture redacted events, transaction hashes, and balance assertions.

Exit criteria:

- Two independent agents complete the deal without direct database access.
- The agents interact only through documented MCP tools and encrypted messages.
- The test produces verifiable NEAR testnet transaction references.

### Phase 8: Security and privacy validation

Tasks:

- [x] Run signature, tamper, replay, and expiry tests.
- [x] Run role and wallet-isolation tests.
- [x] Run insufficient-balance and overflow tests.
- [x] Run TEE identity rotation and rejection tests.
- [x] Run database and log leakage scans.
- [ ] Inspect NEAR explorer data for unintended terms.
- [x] Test seller timeout, buyer timeout, mutual cancel, pause, and recovery.
- [x] Review all privacy claims against observable evidence.

The equivalent public-state inspection has passed in NEAR sandbox. The Explorer
item remains open until Phase 9 creates real testnet transactions to inspect.

Exit criteria:

- No critical or high-severity issue remains open.
- Public chain and server inspection matches the documented privacy model.

### Phase 9: Testnet deployment and judge package

Tasks:

- [x] Deploy the contract to NEAR testnet. It is initialized and deliberately paused pending verified hosted TEE identity.
- [ ] Deploy the TEE worker and verify attestation.
- [ ] Provision the exact two-method NEAR worker key through the CVM encrypted environment, remove the bootstrap FullAccess key, and verify it is the account's only key on-chain.
- [ ] Verify scheduled timeouts and batched root anchoring against the hosted worker.
- [ ] Register the approved TEE identity with the contract.
- [ ] Deploy API, MCP server, frontend, database, and ciphertext storage.
- [ ] Run the full two-agent test against deployed infrastructure.
- [ ] Write exact judge reproduction steps. A complete template is prepared; final hosted URLs and transaction hashes remain pending.
- [ ] Record the demo.
- [x] Update README with reused versus hackathon work.
- [x] Produce architecture, privacy, threat-model, and attestation documents.
- [x] Confirm no secret is present in the current source tree; rerun the automated scan before publication.

All non-hosted Phase 9 work is mapped in
`near/PHASE_9_PREDEPLOYMENT_TRACEABILITY.md`. The testnet pool is deployed in a
paused provisional state. CVM evidence, worker-key encrypted provisioning, public
URLs, reusable deposits, the hosted two-agent run, final Explorer inspection, and
recording remain open until hosting access is supplied.

Exit criteria:

- A judge can follow `do X -> see Y` steps successfully.
- The public repository contains complete setup and evidence.
- The demo shows a real testnet transaction and two independent agents.

## 15. End-to-end test plan

### Test environment

- Actual NEAR testnet contract
- Actual NEAR testnet RPC
- Actual NEAR Confidential Compute deployment
- Verified TEE attestation
- Two separate testnet wallets
- Two separate MCP tokens
- Two separate agent processes or sessions
- Test tokens only

### Happy-path demonstration

1. Seller Agent creates a test API-key listing.
2. Buyer Agent searches the marketplace.
3. Buyer Agent opens an encrypted ticket.
4. Agents negotiate privately.
5. Agents intentionally submit different terms.
6. TEE returns `NO_MATCH` without revealing either submission.
7. Agents renegotiate and submit identical signed terms.
8. TEE returns `MATCH` and locks private balances.
9. Seller Agent encrypts and uploads the API key.
10. Buyer Agent decrypts the key and calls the demonstration API.
11. Buyer Agent confirms delivery.
12. TEE credits the seller and returns both collateral balances.
13. Buyer and seller request withdrawals.
14. Contract transfers testnet funds.
15. Tests assert the final private and public balances.
16. The NEAR explorer is inspected for unintended private data.

### Negative test matrix

| Test | Expected result |
| --- | --- |
| Different final terms | `NO_MATCH` |
| Missing required term | Submission rejected |
| Invalid party signature | Submission rejected |
| Expired submission | Submission rejected |
| Reused nonce | Submission rejected |
| Modified ciphertext | Decryption/authentication failure |
| Buyer token uses seller wallet | Authorization failure |
| Seller confirms as buyer | Authorization failure |
| Insufficient private balance | Funding lock rejected |
| Duplicate confirmation | No duplicate settlement |
| Reused withdrawal authorization | Contract rejects replay |
| Expired withdrawal authorization | Contract rejects withdrawal |
| Unregistered TEE caller | Contract rejects action |
| Invalid workload identity | Client refuses private submission |
| Seller misses deadline | Signed timeout rule executes |
| Buyer remains inactive | Signed timeout rule executes |
| Contract paused | Sensitive operations rejected |
| TEE restart | Ledger recovers consistently |
| Database inspection | Ciphertext only |
| Log inspection | No terms, keys, products, or balances |

### Test evidence package

Keep a judge-readable evidence bundle containing:

- Contract account and code hash
- TEE attestation report or verification summary
- Approved workload measurement
- Buyer and seller public testnet accounts
- Redacted agent transcripts
- MCP tool-call sequence
- Testnet transaction hashes
- Before and after pool balances
- Terms commitment
- Ledger root sequence
- Privacy inspection checklist
- Automated test report

Do not include private keys, MCP tokens, encryption keys, plaintext product secrets, or plaintext private terms.

## 16. Judge demonstration

The primary demonstration should be autonomous and understandable without code knowledge:

1. Show two separately authenticated agents.
2. Show the seller creating a listing through MCP.
3. Show the buyer finding it and opening a ticket.
4. Show encrypted messages existing without exposing their server-side plaintext.
5. Show a failed terms match.
6. Show a successful exact match.
7. Show the private balance lock.
8. Show encrypted product delivery and successful use.
9. Show buyer confirmation and private settlement.
10. Show testnet withdrawals.
11. Open the explorer and explain what an observer can and cannot learn.
12. Show the TEE identity and attestation evidence.

A scripted fallback must reproduce the same protocol deterministically if an external agent model is temporarily unavailable.

## 17. Hackathon schedule

Official development window:

- Start: `2026-11-01T00:00:00Z`
- Submission deadline: `2026-11-14T23:59:00Z`

Suggested execution:

| Day | Target |
| --- | --- |
| 1 | Freeze architecture, schema, privacy model, and TEE capability checks |
| 2 | Shared types, canonical encoding, signatures, and test vectors |
| 3-4 | NEAR pool contract and sandbox tests |
| 5-6 | Deterministic TEE worker and private ledger |
| 7 | API encryption and storage integration |
| 8 | MCP security fixes and NEAR tools |
| 9-10 | Frontend NEAR and private-deal flows |
| 11 | Two-agent end-to-end integration |
| 12 | Security, timeout, replay, and privacy tests |
| 13 | Testnet and TEE deployment, judge documentation |
| 14 | Demo recording, final validation, public repository, submission buffer |

The team should target completion before the final day so deployment or service-access problems do not block submission.

## 18. Definition of done

The project is complete when all of the following are true:

- [ ] Two independent agents can complete a deal entirely through MCP.
- [ ] Each agent uses a separate wallet, identity, and scoped MCP token.
- [ ] The NEAR contract is deployed and working on testnet.
- [ ] The deterministic worker runs in NEAR Confidential Compute.
- [ ] Clients verify the documented TEE identity before sharing private data.
- [ ] No NLP, LLM, or middleman controls matching or settlement.
- [ ] Exact structured terms produce deterministic `MATCH` or `NO_MATCH`.
- [ ] Chat, terms, balances, and delivery are not published on-chain.
- [ ] Database and logs do not contain prohibited plaintext.
- [ ] Deposits and withdrawals work with testnet funds.
- [ ] Replay, impersonation, tamper, timeout, and insufficient-fund tests pass.
- [ ] The README discloses reused foundation and new hackathon work.
- [ ] Privacy limitations and trust assumptions are documented accurately.
- [ ] Judges can reproduce the main scenario from written steps.
- [ ] A recorded demo and public repository are ready before submission.

## 19. Stretch goals

Only begin these after the complete MVP passes end-to-end testing:

- Deterministic API-key validation adapters
- NFT and token delivery verification
- Stablecoin support
- Multiple currencies
- Batched withdrawals
- Merkle proofs for private-ledger inclusion
- Multi-TEE threshold authorization
- Workload-bound confidential key derivation when production-ready
- Mainnet Confidential Intents research
- Selective disclosure receipts
- Reputation based on privacy-preserving proofs
- Custom ZK shielded deposits and withdrawals

## 20. Submission controls

Before the final hackathon submission:

- Re-read the live `HACKATHON.md` because rules may change.
- Make the repository public only after human confirmation.
- Never commit secrets or the submission payload.
- Have the human publish the required public demo post.
- Prepare the exact submission JSON and show it to the human.
- Submit only after explicit human confirmation.
- Use one submission for all applicable tracks.

Likely tracks for evaluation are `privacy`, `security`, `agents`, `business`, and `open`, but the human must make the final track selection.
