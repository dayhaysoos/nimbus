# Phase 10: Fork, Export, and Production Readiness

## Objective
Finalize the end-to-end checkpoint sandbox workflow for production use: reliable export/fork handoff, operational hardening, and launch readiness.

## Why this phase exists
Core capabilities are present, but the production experience needs stronger reliability guarantees, clearer governance controls, and polished handoff paths back to user repositories.

## Product decisions (proposed final)
1. **Handoff is first-class:** fork/export paths must be as robust as deploy path.
2. **Operational defaults conservative:** safe limits and explicit opt-ins for risky operations.
3. **Launch gates measurable:** define SLOs and release criteria before GA.
4. **Cloudflare operations baseline:** all GA gates validated on Cloudflare Worker/D1/R2/Queue/Sandbox production topology.
5. **Artifact durability:** export artifacts stored in R2 with signed download policy and retention enforcement.
6. **Idempotent handoff:** fork/export operations require idempotency keys and replay-safe semantics.
7. **Provider parity checks:** production readiness includes real-provider deploy and rollback/cancel drills.
8. **GA scope:** first GA release is single-tenant only.
9. **Handoff policy:** fork/export does not require a reviewed marker gate.

## In scope
- Harden GitHub fork flow and retry semantics.
- Harden zip/patch export lifecycle and retention policies.
- Add operational SLO dashboards and alerting hooks.
- Add runbooks for common operator failure modes.
- Security review and secret-handling validation.
- Disaster-recovery drill for D1 + R2 metadata consistency.
- Operator "doctor" and bootstrap runbook for cold-start accounts.

## Out of scope
- Enterprise org-wide policy admin UI.
- Multi-region active-active orchestration.

## Deliverables

### D1. Fork/export reliability
- Idempotent fork/export operations with retry-safe semantics.
- Better partial-failure recovery and clearer terminal statuses.
- Signed download validation and expiry behavior tests.

### D2. Governance and security hardening
- Role/permission checks for destructive operations.
- Artifact access control review.
- Secret scan policy tuning and test corpus.
- Required secret inventory and rotation runbook.

### D3. Launch readiness package
- SLO targets and dashboards.
- Incident response runbook updates.
- Smoke suites for checkpoint -> ask/edit -> deploy -> fork/export.

Target launch SLOs:
- Deploy success rate >= 99.0% (excluding user-code validation failures)
- P95 deploy queue-to-terminal <= 5 minutes for static deployments
- Export/fork operation success >= 99.5%
- Event stream reconnect recovery <= 10 seconds

## Acceptance criteria
- End-to-end user story passes from checkpoint selection to repo handoff.
- Operational runbooks cover top known failure classes.
- Reliability metrics meet agreed launch thresholds for a sustained bake period.
- Two-week staging bake meets SLOs without Sev-1 incidents.
- Security review closes all high/critical findings before GA.

## Implementation checklist
1. Add reliability tests for fork/export retries and idempotency.
2. Add security and access-control validation tests.
3. Add release checklist + SLO docs under `specs/testing/`.
4. Run staged load test and capture results.
5. Approve GA gate with metrics evidence.
6. Run Cloudflare account bootstrap drill from empty state and validate `setup:worker` + `doctor` path.
7. Validate data retention/cleanup jobs for deployments, events, and artifacts.
