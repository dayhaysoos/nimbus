# Phase 8A: Review-First Code Review Reports

## Objective
Ship a non-mutating Nimbus review engine that produces actionable, provenance-aware code review reports from workspace/deployment state, with CLI and API surfaces ready for PR workflows.

## Why this phase exists
Nimbus now has reliable workspace/deploy primitives (including real URL reachability checks). The fastest path to user value is not a full editor UI; it is high-quality review reports that combine diff analysis with prompt intent and deployment evidence.

This phase narrows scope so teams can consume Nimbus output in existing agent harnesses and review processes immediately.

## Naming decision
- This should be tracked as **Phase 8A**.
- Phase 8 remains focused on live session/watch UX.
- Phase 8A is a product-track insert that uses the same harness/event foundations but targets review outputs first.

## Product decisions (proposed final)
1. **Report-only v1:** no code edits, no commit/push from review runs.
2. **Cloud-first execution:** canonical review runs execute in Nimbus backend.
3. **CLI as first client:** CLI creates/streams/exports reports from cloud APIs.
4. **Evidence-backed findings:** findings should link to tests, deploy probes, and provenance summaries when available.
5. **Intent-aware summaries:** include prompt/session-derived goal + constraints + decisions in reviewer-facing output.
6. **Pluggable targets:** start with `workspace_deployment`, expand later to `pr` and `git_diff` adapters.
7. **Safe by default:** redact sensitive prompt/session details by policy; raw transcript is opt-in.

## In scope
- Review run API (`create/get/events`) and D1 persistence model.
- Review engine output contract (JSON + markdown summary).
- CLI commands to create/view/export review reports.
- `workspace_deployment` target adapter.
- Evidence pack integration from existing deployment/test artifacts.
- Provenance summary block from Entire/Nimbus run metadata.

## Out of scope
- Browser code editor.
- Auto-apply patches.
- Automatic branch/PR mutation.
- Replacing external agent harnesses.

## Deliverables

### D1. Review data model and lifecycle
- New entities:
  - `review_runs`
  - `review_findings`
  - `review_events`
- States:
  - `queued -> running -> succeeded|failed|cancelled`
- Idempotency support for repeated create requests.

### D2. Review API (v1)
- `POST /api/reviews`
- `GET /api/reviews/:id`
- `GET /api/reviews/:id/events` (SSE)

SSE events (v1):
- `review_preflight_started`
- `review_preflight_completed`
- `review_analysis_started`
- `review_finding_emitted`
- `review_finalize_started`
- `review_succeeded|review_failed`

### D3. Output contract
- JSON report with:
  - summary (risk, recommendation, counts)
  - findings (severity/confidence/conditions/locations/suggested fix)
  - intent block (goal/constraints/decisions)
  - evidence pack refs
  - provenance summary refs
- Markdown summary suitable for PR comment/body.

### D4. CLI UX (v1)
- `nimbus review create --workspace <id> --deployment <id>`
- `nimbus review show <review-id>`
- `nimbus review events <review-id>`
- `nimbus review export <review-id> --format markdown --out review.md`

### D5. Handoff contract for external agent harnesses
- Export findings in machine-consumable format with:
  - stable finding ID
  - severity/confidence
  - file/line location(s)
  - repro conditions
  - suggested remediation text

## Acceptance criteria
- Review run can be created from a successful workspace deployment.
- Report includes at least one intent/provenance section and one evidence section when data exists.
- CLI can export markdown and JSON report for the same review ID.
- Review mode is non-mutating and does not create commits/pushes.
- Idempotent re-create with same key returns same review run.
- SSE events stream from queued to terminal with no stuck states.

## Success metrics (initial)
- >= 80% of findings rated "actionable" in internal pilot feedback.
- < 5% runs end non-terminal/stuck.
- < 10% reports missing evidence/provenance blocks when source data exists.
- Median review completion time under 60s for standard deployment targets.

## Implementation checklist
1. Add DB schema + repository functions for review runs/findings/events.
2. Add API handlers for create/get/events.
3. Implement `workspace_deployment` target adapter.
4. Implement report serializer (JSON + markdown).
5. Add CLI commands (create/show/events/export).
6. Add idempotency + retry behavior parity with existing task/deploy flows.
7. Add policy/redaction guardrails for provenance fields.
8. Add tests:
   - API contract
   - lifecycle terminalization
   - idempotency
   - CLI output/export
9. Document PR integration usage (comment/body template).

## Dependencies and sequencing
- Depends on completed Phase 7 stabilization behavior (real provider + reachability truth).
- Reuses Phase 8 lifecycle/event conventions.
- Precedes optional built-in edit/apply UX work (future 9B track).
