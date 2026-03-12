# Phase 5: Deploy From Workspace

## Objective
Make deployment a deliberate downstream action from validated workspace state, with durable execution, explicit policy gates, and complete provenance links back to workspace/task/operation context.

## Product decisions (final)
1. **Trigger policy:** manual API/CLI trigger only in this phase.
2. **Provider strategy:** `simulated` provider is the default production-safe path (R2 artifact publish + stable URL contract), with provider field reserved for future real deployment adapters.
3. **Retry policy:** transient failures retry up to `maxRetries` (default `2`, max `5`) with queue-safe idempotent claim semantics.
4. **Rollback behavior:** failed deployment retains previously successful deployment as active; no workspace mutation rollback is attempted because workspace state remains immutable to deploy.
5. **Idempotency:** `Idempotency-Key` required on create; key + payload hash dedupe window is 24h.

## In scope
- Deploy from current workspace filesystem state (not source checkpoint bundle).
- Persist deployment records, sequenced events, and workspace-level deployment summary metadata.
- Expose deployment status/events in worker API.
- Queue/runtime path with retries + cancellation.
- Validation + safety policy gates before artifact publish.
- Deployment provenance chain linking workspace + optional task/operation origin.

## Out of scope
- Multi-target deploy matrix.
- Progressive/canary release orchestration.
- Human-in-the-loop approval UX.

## Deliverables

### D1. Schema additions
- `workspace_deployments`
- `workspace_deployment_events`
- `workspace_deployment_idempotency`
- `workspaces` summary columns:
  - `last_deployment_id`
  - `last_deployment_status`
  - `last_deployed_url`
  - `last_deployed_at`
  - `last_deployment_error_code`
  - `last_deployment_error_message`

### D2. Worker APIs
- `POST /api/workspaces/:id/deploy`
- `GET /api/workspaces/:id/deployments/:deployId`
- `GET /api/workspaces/:id/deployments/:deployId/events`
- `POST /api/workspaces/:id/deployments/:deployId/cancel`

### D3. Runtime + queue integration
- Queue message contract: `workspace_deployment_requested`.
- Claim-by-status execution (`queued -> running`) with retry rescheduling.
- Validation/build gates, artifact publish, status/event persistence.

## API contract

### POST `/api/workspaces/:id/deploy`
Headers:
- `Idempotency-Key` (required)

Request body:
```json
{
  "provider": "simulated",
  "validation": {
    "runBuildIfPresent": true,
    "runTestsIfPresent": true
  },
  "retry": {
    "maxRetries": 2
  },
  "rollbackOnFailure": true,
  "provenance": {
    "trigger": "manual",
    "taskId": "task_ab12cd34",
    "operationId": "op_ab12cd34",
    "note": "deploy after task review"
  }
}
```

Defaults:
- `provider = simulated`
- `validation.runBuildIfPresent = true`
- `validation.runTestsIfPresent = true`
- `retry.maxRetries = 2` (clamped `0..5`)
- `rollbackOnFailure = true`
- `provenance.trigger = manual`

Response `202` (new):
```json
{
  "deployment": {
    "id": "dep_ab12cd34",
    "workspaceId": "ws_1234abcd",
    "status": "queued",
    "provider": "simulated",
    "idempotencyKey": "deploy-req-001",
    "maxRetries": 2,
    "attemptCount": 0,
    "sourceSnapshotSha256": null,
    "sourceBundleKey": null,
    "deployedUrl": null,
    "providerDeploymentId": null,
    "cancelRequestedAt": null,
    "startedAt": null,
    "finishedAt": null,
    "provenance": {
      "trigger": "manual",
      "taskId": "task_ab12cd34",
      "operationId": "op_ab12cd34",
      "note": "deploy after task review"
    },
    "createdAt": "2026-03-08T12:00:00.000Z",
    "updatedAt": "2026-03-08T12:00:00.000Z"
  }
}
```

Response `200` (idempotent replay): same shape with existing deployment.

Errors:
- `400`: invalid request body, missing idempotency header.
- `403`: `workspace_deploy_disabled`.
- `404`: workspace missing.
- `409`: workspace not ready or idempotency payload conflict.
- `503`: deploy runner unavailable (no queue and no execution context).

### GET `/api/workspaces/:id/deployments/:deployId`
Response `200`:
```json
{
  "deployment": {
    "id": "dep_ab12cd34",
    "status": "succeeded",
    "deployedUrl": "https://deployments.nimbus.local/ws_1234abcd/dep_ab12cd34",
    "sourceSnapshotSha256": "f6b6...",
    "sourceBundleKey": "workspaces/ws_1234abcd/deployments/dep_ab12cd34/source.tar.gz",
    "result": {
      "artifact": {
        "sourceBundleKey": "workspaces/ws_1234abcd/deployments/dep_ab12cd34/source.tar.gz",
        "sourceSnapshotSha256": "f6b6..."
      },
      "provenance": {
        "workspaceId": "ws_1234abcd",
        "taskId": "task_ab12cd34",
        "operationId": "op_ab12cd34",
        "trigger": "manual"
      }
    }
  }
}
```

### GET `/api/workspaces/:id/deployments/:deployId/events?from=0&limit=500`
Response `200`:
```json
{
  "deploymentId": "dep_ab12cd34",
  "events": [
    {
      "seq": 1,
      "eventType": "deployment_created",
      "payload": {
        "provider": "simulated"
      },
      "createdAt": "2026-03-08T12:00:00.000Z"
    }
  ]
}
```

### POST `/api/workspaces/:id/deployments/:deployId/cancel`
Response `202`:
```json
{
  "deployment": {
    "id": "dep_ab12cd34",
    "status": "running",
    "cancelRequestedAt": "2026-03-08T12:01:00.000Z"
  }
}
```

Errors:
- `404`: workspace/deployment missing.
- `409`: deployment already terminal and not cancellable.

## Data model

### `workspace_deployments`
- identity: `id`, `workspace_id`
- request: `provider`, `idempotency_key`, request payload/hash
- execution: `status`, `max_retries`, `attempt_count`, `started_at`, `finished_at`, `cancel_requested_at`, `duration_ms`
- output: `source_snapshot_sha256`, `source_bundle_key`, `provider_deployment_id`, `deployed_url`, `result_json`
- errors: `error_code`, `error_message`
- provenance: `provenance_json`
- observability: `last_event_seq`, timestamps

### `workspace_deployment_events`
- sequenced event log (`deployment_id`, `seq`, `event_type`, `payload_json`, `created_at`)

### `workspace_deployment_idempotency`
- dedupe record (`workspace_id`, `idempotency_key`) with `request_payload_sha256`, `deployment_id`, 24h `expires_at`

### `workspaces` summary metadata
- latest deployment pointer/status/error and active URL fields for quick UI/API reads

## Lifecycle states
- `queued`: accepted, waiting for runtime claim.
- `running`: runtime claimed and executing validations/publish.
- `succeeded`: artifact + URL persisted, workspace summary updated.
- `failed`: permanent failure or retries exhausted; rollback context persisted in result.
- `cancelled`: cancel requested before terminal completion.

## Retry and idempotency
- Retryable: transient provider/network/sandbox/DB-lock timeout classes.
- Non-retryable: request validation, policy violations, provenance mismatch, missing baseline.
- On retry: status returns to `queued` with `error_code=retry_scheduled`, `attempt_count` incremented only on new claim.
- Idempotent create: same key + same payload hash returns prior deployment (`200`).
- Conflict: same key + different payload hash returns `409 idempotency_key_conflict`.

## Validation and policy gates
- Feature flag gate: `workspace_deploy_enabled` (`WORKSPACE_DEPLOY_ENABLED` env default + runtime override).
- Workspace must exist and be `ready`.
- Workspace git baseline must exist (`HEAD` required).
- Current implementation note: workspace `baselineReady` is only a cached readiness hint. The actual git baseline lives inside sandbox `.git` state and can drift or disappear if the sandbox filesystem is replaced or rehydrated from source artifacts that exclude `.git`.
- Hardening follow-up: make git-dependent operations rehydrate/verify baseline automatically, or persist a canonical baseline artifact/metadata that can deterministically recreate the repo so baseline availability is effectively guaranteed.
- Optional validation commands:
  - `npm run -s test` when `package.json` has `scripts.test` and `runTestsIfPresent=true`
  - `npm run -s build` when `package.json` has `scripts.build` and `runBuildIfPresent=true`
- Provenance linkage policy:
  - `provenance.taskId` must belong to workspace when supplied
  - `provenance.operationId` must belong to workspace when supplied

## Artifact and provenance chain
On success, deployment stores:
- workspace id
- deployed URL
- provider deployment id
- source snapshot sha256
- source bundle object key
- provenance trigger + optional task/operation links

R2 object key contract:
- `workspaces/{workspaceId}/deployments/{deploymentId}/source.tar.gz`

## Failure modes and error codes
- `workspace_deploy_disabled`: feature flag off.
- `workspace_not_ready`: workspace not ready.
- `baseline_missing`: git baseline missing.
- `invalid_provenance_task`: referenced task not found in workspace.
- `invalid_provenance_operation`: referenced operation not found in workspace.
- `retry_scheduled`: transient failure queued for retry.
- `deployment_failed`: runtime failure after retries exhausted.
- `deployment_not_found`: request payload/deployment record missing unexpectedly.
- `deployment_not_cancellable`: cancel requested after terminal state.

## Rollback behavior
- Workspace files are not mutated during deploy; no workspace rollback needed.
- When deployment fails and `rollbackOnFailure=true`, runner records rollback context:
  - `retained_previous` with prior successful deployment id/url, or
  - `no_previous_success` when none exists.
- Workspace `last_deployed_url` remains unchanged on failed deployment, preserving active deployment pointer.

## Migration sketch
1. Add `0007_workspace_deployments.sql`.
2. Add workspace summary columns via `ALTER TABLE`.
3. Create deployments/events/idempotency tables + indexes.
4. Deploy worker with feature flag default off.
5. Enable in staging, verify event flow and retries.
6. Enable in production incrementally.

## Acceptance criteria
- `POST /deploy` creates queued deployment from workspace state (not stale checkpoint source).
- Successful deployment persists stable URL + artifact metadata + provenance chain.
- Failed deployment records actionable error + rollback context without corrupting workspace.
- Cancellation and retry behaviors are durable and evented.
- Workspace summary metadata reflects latest deployment state and active URL.

## Test plan
- Integration-style:
  - create workspace deployment -> run -> success, verify status + URL + artifact/provenance fields.
  - create deployment with invalid provenance task/operation -> policy failure.
  - transient runtime failure -> retry scheduled -> eventual terminal state.
  - cancel queued/running deployment -> cancelled state/event behavior.
  - failure path records rollback context (`retained_previous` or `no_previous_success`).
- Unit:
  - queue payload parse/validation.
  - retry classifier.
  - request schema defaults + clamping.

## Rollout
1. Ship dark (`workspace_deploy_enabled=false`).
2. Enable in internal/staging with `provider=simulated`.
3. Validate event quality, retry/cancel semantics, and provenance links.
4. Roll out broadly after operational confidence.
