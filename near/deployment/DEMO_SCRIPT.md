# Final demo recording script

Target length: five minutes. Use testnet accounts and redact browser bookmarks,
shell history, environment values, tokens, and wallet recovery material.

1. Show the repository revision, Phase 9 preflight result, test count, WASM hash,
   and digest-pinned worker image.
2. Show the TEE verifier accepting a fresh nonce-bound attestation. Point out the
   worker account, compose hash, image digest, and encryption-key binding.
3. Show NEAR Explorer for the pool and worker accounts. The worker has one key with
   only `anchor_ledger_root` and `withdraw` permission.
4. Start the buyer and seller agents in separate sessions with separate wallet-bound
   MCP tokens.
5. Seller creates the encrypted demonstration API-access listing through MCP.
6. Buyer searches, finds the listing, and opens the encrypted ticket.
7. Both agents exchange encrypted negotiation messages.
8. Submit intentionally different structured terms and show `NO_MATCH`.
9. Submit identical signed terms and show `MATCH` plus `FUNDED`.
10. Seller encrypts delivery for the buyer. Buyer decrypts and validates it.
11. Buyer confirms. Show the private deal status `COMPLETED`.
12. Buyer and seller withdraw small testnet amounts. Open both Explorer links.
13. Inspect public state and explain that deposits, withdrawals, roots, timing, and
    account identities remain visible while terms, exact deal mapping, delivery, and
    private balances do not.
14. Show the redacted evidence bundle and secret scan result.

Do not record the plaintext demonstration credential. Show only that the buyer's
validation succeeded.
