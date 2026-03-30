# Module: Review Execution

## Status

- State: current-state baseline
- Owner: `packages/worker/src/lib/review-runner.ts`

## Purpose

Run a review from queued state to terminal state, including context assembly, model-backed analysis, validation, persistence of findings, retry handling, and lifecycle event emission.

## Boundaries

- Inputs:
  - review ID
  - persisted review request payload
  - workspace and deployment metadata
  - optional scoped GitHub token and OpenRouter API key override
- Outputs:
  - updated review status
  - persisted report/findings
  - review events
- External dependencies:
  - D1
  - R2-backed review context references
  - OpenRouter-backed model execution
  - `ReviewRunner` durable object handoff
- Things this module must not own:
  - public HTTP request parsing
  - CLI orchestration
  - report UI rendering

## Important Concepts

- Review context assembly: the review gathers diff, changed files, conventions, Entire session context, and co-change evidence before analysis.
- Policy-first execution: reviews may be created earlier but do not run until an approved policy exists for the policy-first path.
- Retry semantics: stale-running detection, queue retries, and repair cycles attempt to preserve review completion without dropping work.

## Core Flow

1. Review is created and enqueued by the worker API.
2. Queue dispatch hands the review to `ReviewRunner` durable object by review ID.
3. The durable object calls inline review execution with retries.
4. The runner assembles context, calls model-backed analysis, validates/normalizes output, persists results, and emits terminal events.

## Invariants

- Supported review target is currently `workspace_deployment` only.
- Supported review mode is currently `report_only` only.
- Review execution must emit enough event history for polling and SSE clients to reconstruct progress.

## Failure Modes

- Context assembly fails because required source material, session context, or co-change inputs cannot be resolved.
- Model output is empty, malformed, or fails structured validation.
- Execution stalls in `running`, requiring retry scheduling or forced failure.

## Source References

- `packages/worker/src/lib/review-runner.ts`
- `packages/worker/src/review-runner-do.ts`
- `packages/worker/src/lib/review-dispatch.ts`
- `packages/worker/src/api/reviews.ts`

## Notes For Future Refactors

- Split context assembly, analysis orchestration, output validation, and persistence into distinct service modules.
- Keep retry and stale-running recovery explicit and testable.
