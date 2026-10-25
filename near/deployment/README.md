# Phase 9 deployment package

This directory contains the public, non-secret material needed to deploy AIR OTC on
NEAR testnet and present it to judges.

- `TESTNET_RUNBOOK.md`: operator sequence from faucet funding through evidence.
- `JUDGE_REPRODUCTION.md`: clean public verification steps.
- `DEMO_SCRIPT.md`: final five-minute recording order.
- `SECURITY_AND_PRIVACY.md`: architecture, privacy boundary, and threat model.
- `ATTESTATION.md`: exact confidential-workload verification gate.
- `REUSE_DISCLOSURE.md`: prior repository work versus the NEAR implementation.
- `EVIDENCE_TEMPLATE.md`: redacted evidence checklist.
- `TESTNET_STATE.md`: current public accounts, deployment transactions, and paused bootstrap status.
- `testnet.env.example`: placeholder-only runtime inventory.
- `agents/`: deterministic buyer and seller prompts for separate agent sessions.

The demonstration product service is under `near/demo-api/`. It lets the buyer
prove that the privately delivered credential works without revealing it.

The transaction and inspection scripts are under `near/scripts/`. Live evidence is
written under `near/evidence/`, which Git ignores.
