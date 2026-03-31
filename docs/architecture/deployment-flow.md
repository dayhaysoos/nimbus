# Deployment Flow

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe workspace deployment preflight, execution, polling, and cancellation.

## Trigger Paths

- CLI-triggered deployment: `nimbus workspace deploy <workspace-id>` runs a preflight request first, prints checks and remediations, then creates a deployment and polls for terminal status.
- API-triggered deployment: clients call `POST /api/workspaces/:id/deploy/preflight`, then `POST /api/workspaces/:id/deploy`, then poll `GET /api/workspaces/:id/deployments/:deploymentId` or `GET /api/workspaces/:id/deployments/:deploymentId/events`.

## High-Level Steps

1. Preflight request
2. Validation and remediation planning
3. Deployment request creation
4. Queue dispatch / execution
5. Event streaming / polling
6. Completion or cancellation

Current implementation details:

1. The CLI calls the worker preflight endpoint before creating a deployment and treats preflight output as the operator-facing readiness report.
2. The worker blocks deployment creation unless the runtime flag `workspaceDeployEnabled` is enabled.
3. The worker validates workspace readiness, payload shape, provider selection, output directory safety, retry settings, validation settings, and provenance fields in `packages/worker/src/api/workspace-deployments.ts`.
4. A deployment record is created in D1 with idempotency protection before execution starts.
5. For `cloudflare_workers_assets`, the worker performs provider precheck before enqueueing execution.
6. Execution is either queued through `WORKSPACE_DEPLOYS_QUEUE` or run inline through `ExecutionContext.waitUntil`, depending on environment configuration.
7. The deployment runner claims the record, re-checks state, runs preflight-sensitive workspace preparation, performs install/build/test behavior as requested, invokes the provider, and persists result state plus deployment events.
8. Cancellation is cooperative. A cancel request may mark a queued deployment cancelled immediately, or mark a running deployment as cancel-requested and rely on reconciliation logic to finish the transition.

## Inputs And Outputs

- Inputs:
  - workspace ID
  - `Idempotency-Key`
  - provider selection
  - validation toggles for build and test
  - auto-fix toggles for baseline rehydrate and toolchain bootstrap
  - optional deploy output directory
  - optional provenance fields such as repo, session IDs, task ID, and operation ID
- Outputs:
  - preflight result with `ok`, checks, toolchain profile, remediations, and optional `nextAction`
  - deployment record with status, provider metadata, result payload, error details, and summary fields
  - deployment events for queueing, provider creation, retry scheduling, success, failure, and cancellation
- Provider dependencies:
  - `simulated`
  - `cloudflare_workers_assets`
  - provider precheck and status polling via `workspace-deploy-provider`

## State Model

- States:
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
  - create path: `queued -> running -> terminal`
  - retry recovery may temporarily keep a deployment in `queued` with `retry_scheduled` semantics before execution resumes
  - cancel path: `queued -> cancelled` or `running -> cancel requested -> reconciled terminal state`
  - stale-running reconciliation may force `running -> failed`

## Failure Modes

- Preflight fails because the workspace is not ready, the git baseline is missing, potential secrets were detected, toolchain detection fails, or provider configuration is invalid.
- Provider precheck fails before enqueue, causing the deployment to be persisted as failed without starting execution.
- Inline or queued execution stalls in `running`; stale-timeout reconciliation or retry logic determines whether the deployment is failed or re-attempted.

## Non-Regression Expectations

- Preflight must remain a read-mostly readiness check that reports checks, remediations, and next-action guidance without silently creating a deployment.
- Deployment creation must preserve idempotency semantics and continue persisting the deployment record before background execution begins.
- Cancellation must continue to be safe for both queued and running deployments, even when provider state is only partially known.

## Current Implementation References

- `packages/cli/src/commands/workspace/deploy.ts`
- `packages/worker/src/api/workspace-deployments.ts`
- `packages/worker/src/lib/workspace-deployment-runner.ts`
- `packages/worker/src/lib/workspace-deploy-provider.ts`
- `packages/worker/src/lib/workspace-toolchain.ts`
- `packages/worker/src/lib/flags.ts`

## Refactor Notes

- Keep preflight, execution, provider integration, and event serialization clearly separated.
