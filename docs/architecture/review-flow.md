# Review Flow

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe the end-to-end review lifecycle from trigger through final report.

## Trigger Paths

- CLI-triggered review flow: `nimbus review create --commit ...` resolves local commit/checkpoint context, creates a workspace, runs workspace deployment, then creates a review and waits for terminal status.
- CI-triggered review flow: `.github/workflows/nimbus-pr-review.yml` builds the CLI, validates PR trust, performs auth exchange, runs review preflight, and runs review creation in GitHub Actions.
- Any direct API-triggered flow: clients can call `POST /api/reviews` directly for an existing succeeded workspace deployment, or `POST /api/reviews/policy/derive` followed by `POST /api/reviews/:id/policy/approve` for the policy-first path.

## High-Level Steps

1. Trigger
2. Preflight
3. Workspace/deployment resolution
4. Review creation
5. Policy derivation / approval if applicable
6. Queue dispatch / execution
7. Event streaming / polling
8. Final result retrieval

Current implementation details:

1. CLI flow resolves a commit SHA, checkpoint trailer, diff patch, Entire intent context, and local co-change context in `packages/cli/src/commands/review/create.ts`.
2. The CLI creates a workspace and deployment before requesting a review when starting from a commit.
3. The worker accepts only `workspace_deployment` targets and only `report_only` review mode in `packages/worker/src/api/reviews.ts`.
4. The direct `POST /api/reviews` path enqueues the review immediately after validation.
5. The policy-first path creates a review in `policy_pending`, derives policy, transitions to `policy_ready`, waits for approval, then enqueues execution.
6. Review queue messages are handed off to the `ReviewRunner` durable object in `packages/worker/src/lib/review-dispatch.ts`.
7. The durable object invokes `runReviewInlineWithRetries` through `packages/worker/src/review-runner-do.ts`.
8. Clients consume lifecycle state either by polling `GET /api/reviews/:id` or by subscribing to `GET /api/reviews/:id/events`.

## Inputs

- Required inputs:
  - direct API path: `Idempotency-Key`, `target.workspaceId`, `target.deploymentId`
  - commit-based CLI path: a resolvable commit-ish and readable Entire checkpoint context
  - review provenance: repo and branch are required for policy derivation and review history grouping
- Optional inputs:
  - severity threshold, max findings, model override, intent-summary model, provenance toggles
  - scoped GitHub token for co-change fallback paths
  - OpenRouter API key override
- External dependencies:
  - worker D1 state
  - review queue
  - `ReviewRunner` durable object
  - OpenRouter-backed review analysis / intent summarization
  - local git and Entire checkpoint history for commit-based CLI flow

## State Model

- States:
  - `policy_pending`
  - `policy_ready`
  - `policy_approved`
  - `queued`
  - `running`
  - `succeeded`
  - `failed`
  - `cancelled`
- Terminal states:
  - `succeeded`
  - `failed`
  - `cancelled`
- Important transitions:
  - policy-first path: `policy_pending -> policy_ready -> policy_approved -> queued -> running -> terminal`
  - direct review path: `queued -> running -> terminal`
  - stale-running recovery may transition `running -> queued` for retry scheduling before a later terminal state

## Failure Modes

- Checkpoint or Entire context resolution fails before workspace creation in the commit-based CLI flow.
- Review creation fails because the target deployment is missing or not in `succeeded` state.
- Review execution stalls in `running`; the worker may re-enqueue it if retry conditions are met, or mark it failed if recovery is unavailable.

## Non-Regression Expectations

- The worker must continue rejecting unsupported review target types and unsupported review modes.
- The policy-first path must preserve its current states and continue requiring explicit approval before enqueuing execution.
- Review events must remain consumable through `GET /api/reviews/:id/events`, including persisted events, heartbeat events, and a final terminal frame.

## Current Implementation References

- `packages/cli/src/commands/review/create.ts`
- `packages/cli/src/commands/review/preflight.ts`
- `packages/cli/src/commands/review/policy.ts`
- `packages/worker/src/api/reviews.ts`
- `packages/worker/src/lib/review-dispatch.ts`
- `packages/worker/src/review-runner-do.ts`
- `packages/worker/src/lib/review-runner.ts`
- `.github/workflows/nimbus-pr-review.yml`

## Refactor Notes

- Keep behavior stable while splitting transport, orchestration, and provider concerns.
