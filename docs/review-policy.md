# Nimbus Review Policy

## Goal

Maximize high-impact catches (security, billing, runtime reliability) while minimizing low-value review churn.

## Default Approach

- Use targeted review for risky surfaces.
- Skip full deep review for routine, localized edits.
- Run deep cross-cutting review at major milestones.

## Risk Tiers

### Tier 1 (high risk, always deep review)

- Auth, secrets, token handling
- External provider calls (OpenRouter, GitHub, billing-facing APIs)
- Worker streaming, queue orchestration, retry behavior
- Deployment/setup scripts and infra config (`wrangler.toml`, secret wiring)
- Database query strategy and migrations

### Tier 2 (medium risk, focused review)

- Review context assembly and co-change logic
- Output validation/normalization and parsing
- Timeout, cancellation, and error propagation paths

### Tier 3 (low risk, light review)

- Pure refactors with no behavior change
- Logging/message wording
- Test-only updates

## Review Cadence

### Every change

- Run tests for touched package(s)
- Run quick focused review on modified files

### Deep review required when any is true

- Change touches Tier 1 files/components
- Request/response contract between workers changes
- Queue/SSE polling, timeout, retry, or idempotency behavior changes
- Secret/env behavior is introduced or changed

### Deep review can be skipped when all are true

- Change is Tier 3 only
- Touched package tests pass

## Diminishing Returns Stop Rule

Switch to targeted review only until next Tier 1 change when all are true across the last 3 review rounds:

- No high-severity findings
- Findings are only style/minor medium with no production impact
- End-to-end review scenario passes at least twice

## Merge Gates

- Affected package tests pass (`nimbus-worker`, `nimbus-agent-endpoint`, etc.)
- One successful end-to-end `review create` run for Tier 1/Tier 2 changes
- No unresolved high findings
- Any accepted medium finding has explicit rationale in PR

## Weekly Safety Pass (30 minutes)

Review recent changes in:

- `packages/worker/src/lib/review-*`
- `packages/agent-endpoint/src/*`
- `scripts/setup-worker.mjs`
- `packages/*/wrangler.toml`

Check for:

- secret leaks
- unauthenticated endpoints
- unbounded loops/queries
- missing timeouts
- schema drift

## PR Metadata Requirements

Every PR should include:

- Risk tier: `T1`, `T2`, or `T3`
- Contract changed: `yes/no` (and which contract if yes)
- Secrets/auth touched: `yes/no`
- E2E run ID (required for Tier 1 and Tier 2): `rev_xxx`
- Accepted risks (if any): short bullet list
