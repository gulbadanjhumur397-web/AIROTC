# Phases 4–6 requirement-to-code comparison

Status: **28/28 roadmap requirements mapped and locally verified** (22 implementation tasks plus 6 exit-criterion groups).

This comparison measures code and local integration. Live testnet/CVM deployment and the two-agent public demonstration are explicitly Phase 7–9 work.

## Phase 4 — API and encrypted storage (7 tasks; both exit criteria included below)

| Roadmap requirement | Implementation | Verification |
|---|---|---|
| Encrypted ticket storage | `privacy-api/src/service.ts` stores only dual `EncryptedEnvelopeV1` message copies; `store.ts` encrypts the entire state file | `privacy-api.test.ts` wallet/ticket test and raw-file sentinel scan |
| Encrypted delivery storage | Seller upload is an authenticated buyer envelope plus SHA-256 commitment | Role/isolation test and browser privacy test |
| Opaque deal references | CSPRNG `listing_`, `ticket_`, `message_`, and `delivery_` references | Domain tests use and replay-check generated references |
| No floating-point financial values | `validation.ts` accepts canonical u128 decimal strings; web/MCP accept atomic strings | Type tests, policy tests, repository scan |
| No NEAR middleman | The NEAR workspace imports no legacy `middleman-agent`; matching is only in `tee-worker` | Production-source import scan |
| Ciphertext-only TEE proxy | `/v1/worker/terms/{role}` and action routes validate envelopes without decrypting | Capturing-proxy test plus browser/MCP/real-worker integration |
| Rate limits and audit-safe logs | `FixedWindowRateLimiter`, path-only audit records, bounded JSON, exact CORS origin, security headers | HTTP rate/log/query/token leakage test |
| DB contains no plaintext private fields | Whole-file AES-256-GCM with random nonce, AAD, auth tag, atomic rename, mode `0600` | Product/message/delivery sentinel scan, tamper rejection, restart recovery |
| API cannot approve or settle | API owns no worker signing key and exposes only ciphertext proxy methods | Architecture inspection and real worker boundary integration |

## Phase 5 — MCP security and tools (7 tasks; the tool-surface task is expanded by category)

| Roadmap requirement | Implementation | Verification |
|---|---|---|
| Exact token scopes | `TokenService.requireScope` on every API read/mutation; pool reads and writes have separate routes | Privacy API tests and MCP authorization matrix |
| Immutable wallet identity | One-use NEP-413 challenge fixes wallet, roles, scopes, policy, and expiry; token record is immutable until rotation/revocation | Valid-signature issue/rotate/revoke test |
| No delegated-wallet bypass | No wallet ID is accepted by tool actions; signer/account comes only from process config/token | Tool-schema and source inspection |
| Marketplace tools | `marketplace_list`, `marketplace_create` | MCP discovery and ciphertext-body test |
| Ticket tools | create/list/get/messages/send with local recipient encryption/decryption | MCP discovery and cross-client chat integration |
| Terms and pool tools | exact signed terms, identity, attestation, deposit claim, balance | MCP discovery, worker encryption test, integration match |
| Delivery and withdrawal tools | encrypted store/get, signed submit/confirm, deal state/cancel/timeout, capped withdrawal | MCP discovery and per-tool denial matrix |
| Role checks | Seller listing/delivery, buyer ticket/confirmation, and role-specific terms endpoints | Privacy service role tests; worker role enforcement tests |
| Spending policies | Atomic per-action/cumulative caps, rollback on upstream failure, worker-verified amount commitment | API retry/cumulative test and worker policy-mismatch test |
| Rotation and revocation | API plus MCP internal token replacement and frontend controls | Token lifecycle tests and MCP no-return-token test |
| Safe errors/no secret output | Sanitized upstream errors and recursive forbidden-key response guard | MCP response guard test and log leakage scans |

## Phase 6 — frontend (8/8 tasks)

| Roadmap requirement | Implementation | Verification |
|---|---|---|
| NEAR testnet wallet | Wallet Selector 10, MyNearWallet, NEP-413 token grant, limited session-key authorization | Strict typecheck and production build |
| Pool deposit/balance | Secret commitment, payable `deposit`, private claim, private balance query | Client code plus actual worker integration boundary |
| Ticket creation/encrypted chat | Ticket form, local dual-recipient encryption, local party decryption | Browser privacy test and browser-to-MCP chat integration |
| Structured terms review/sign | Separate review and sign steps; canonical terms signed locally then encrypted | Type/build checks and two-party exact-match integration |
| TEE verification state | Identity view, fresh random nonce, evidence label distinguishing dstack from development | UI code and build |
| Encrypted delivery/confirmation | Local buyer encryption/decryption, commitment, seller submit, buyer confirm | Browser privacy test and role-specific action paths |
| Withdrawal | Atomic amount form, signed encrypted action, API cap, amount commitment, TEE authorization | API/worker policy tests and build |
| Privacy/timeout explanations | Dedicated public/private panel and explicit seller/buyer timeout outcomes | UI source/build review |

## Exit-criterion groups (6/6)

| Gate | Evidence |
|---|---|
| Privacy API checks | Typecheck/build pass; 5 storage, authorization, rate, proxy, leakage, tamper, restart tests pass |
| No persisted/logged raw secrets | Encrypted raw-file scan and end-to-end persistence/log sentinel assertions pass |
| MCP complete and wallet isolated | 22 tools exposed; 30 MCP tests pass, including every high-impact authorization/replay case |
| Frontend human flow/privacy | Typecheck, 2 browser privacy tests, and production build pass; all eight Phase 6 panels implemented |
| Ciphertext-only cross-boundary integration | Browser buyer + MCP seller + privacy API + real confidential worker integration test passes |
| Traceability | This document maps every Phase 4–6 roadmap task and exit criterion to code/test evidence |
