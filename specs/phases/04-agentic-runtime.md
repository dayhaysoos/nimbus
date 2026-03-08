# Phase 4: Agentic Runtime

## Objective
Enable fully autonomous agent tasks that can modify workspace code with durable execution, strong policy guardrails, and complete event observability.

## Product decisions (final)
1. **Autonomy level:** full autonomy (no human approval checkpoints in-run).
2. **Provider/model strategy:** model/provider is switchable per task and via env defaults; Cloudflare Agent SDK is the primary provider integration path.
3. **Retry policy:** retry only transient failures, max 2 retries by default (3 total attempts), idempotent queue/claim semantics.

## In scope
- Workspace task model and queue-backed execution loop.
- Task tool contract for controlled file/command operations.
- Durable task event log with sequenced events.
- Cancellation and idempotency.
- Runtime policy enforcement (commands, paths, output limits, time/step limits).

## Out of scope
- Multi-agent orchestration/marketplace.
- Unbounded shell or network tool access.
- Rich human approval UX beyond cancel endpoint.

## User stories
1. As a developer, I can create an autonomous task that edits workspace code.
2. As a developer, I can poll task status and stream task events.
3. As a developer, I can cancel a task and leave workspace state coherent.
4. As a developer, I can inspect task-produced diff output before export/fork.

## Deliverables

### D1. Schema additions
- `workspace_tasks`
- `workspace_task_events`
- `workspace_task_idempotency`

### D2. Worker APIs
- `POST /api/workspaces/:id/tasks`
- `GET /api/workspaces/:id/tasks/:taskId`
- `GET /api/workspaces/:id/tasks/:taskId/events`
- `POST /api/workspaces/:id/tasks/:taskId/cancel`

### D3. Runtime
- Queue message contract for task execution.
- Autonomous step loop with tool execution and terminal result.
- Retry classification and requeue behavior.

### D4. Tooling contract
- `list_files`
- `read_file`
- `write_file`
- `run_command` (allowlisted + denylisted)
- `diff_summary`

## API contract

### POST `/api/workspaces/:id/tasks`
Headers:
- `Idempotency-Key` (required)

Request body:
```json
{
  "prompt": "Refactor auth middleware to handle missing tokens",
  "provider": "cloudflare_agents_sdk",
  "model": "claude-3-7-sonnet",
  "maxSteps": 24,
  "maxRetries": 2
}
```

Response `202` (new):
```json
{
  "task": {
    "id": "task_ab12cd34",
    "workspaceId": "ws_1234abcd",
    "status": "queued",
    "prompt": "Refactor auth middleware to handle missing tokens",
    "provider": "cloudflare_agents_sdk",
    "model": "claude-3-7-sonnet",
    "idempotencyKey": "task-req-001",
    "maxSteps": 24,
    "maxRetries": 2,
    "attemptCount": 0,
    "startedAt": null,
    "finishedAt": null,
    "cancelRequestedAt": null,
    "createdAt": "2026-03-08T12:00:00.000Z",
    "updatedAt": "2026-03-08T12:00:00.000Z"
  }
}
```

Response `200` (idempotent replay): same shape with existing task.

Errors:
- `400` missing/invalid request
- `403` runtime disabled (`workspace_agent_runtime_disabled`)
- `404` workspace missing
- `409` workspace not ready or idempotency payload conflict

### GET `/api/workspaces/:id/tasks/:taskId`
Response `200`:
```json
{
  "task": {
    "id": "task_ab12cd34",
    "status": "succeeded",
    "result": {
      "summary": "Updated middleware and tests",
      "stepsExecuted": 7
    }
  }
}
```

### GET `/api/workspaces/:id/tasks/:taskId/events?from=0&limit=500`
Response `200`:
```json
{
  "taskId": "task_ab12cd34",
  "events": [
    {
      "seq": 1,
      "eventType": "task_created",
      "payload": {"provider": "cloudflare_agents_sdk"},
      "createdAt": "2026-03-08T12:00:00.000Z"
    }
  ]
}
```

### POST `/api/workspaces/:id/tasks/:taskId/cancel`
Response `202`:
```json
{
  "task": {
    "id": "task_ab12cd34",
    "status": "running",
    "cancelRequestedAt": "2026-03-08T12:01:00.000Z"
  }
}
```

## Data model

### `workspace_tasks`
- identity: `id`, `workspace_id`
- request: `prompt`, `provider`, `model`, `idempotency_key`, payload hash/json
- execution: `status`, `max_steps`, `max_retries`, `attempt_count`, `started_at`, `finished_at`, `cancel_requested_at`
- result: `result_json`, `error_code`, `error_message`
- observability: `last_event_seq`, timestamps

### `workspace_task_events`
- sequenced event log (`task_id`, `seq`, `event_type`, `payload_json`, `created_at`)

### `workspace_task_idempotency`
- dedupe record (`workspace_id`, `idempotency_key`) with `request_payload_sha256`, `task_id`, and 24h `expires_at`

## Runtime architecture

1. `POST /tasks` creates queued task row + idempotency row.
2. API enqueues `workspace_task_created` message.
3. Queue consumer claims task atomically (`queued -> running`, increments attempt).
4. Runner executes autonomous step loop until:
   - `succeeded` with final summary,
   - `failed` on permanent/policy errors,
   - `cancelled` when cancel requested,
   - retried on transient failure and under retry cap.
5. Every significant transition emits a durable task event.

## Retry policy (recommended)

- **Transient retryable classes:** sandbox timeout/temporary unavailability, provider network failures, HTTP 5xx from provider endpoint.
- **Permanent failures:** invalid prompt payload, policy violations, invalid tool action, max-steps exceeded.
- **Default limits:** `maxRetries = 2` (3 total attempts including first).
- **State behavior:** on retry, task returns to `queued` with `error_code=retry_scheduled`; queue message is retried.
- **No duplicate side effects:** claim-by-status CAS ensures single active execution at a time.

## Safety and policy

- Command allowlist + explicit deny patterns for high-risk operations.
- Path confinement to `/workspace` with traversal protection.
- `.git` treated as protected path for file tools.
- Output truncation and command timeout caps.
- Error sanitization for secret/token-like patterns.
- Hard stop on `maxSteps`.

## Cloudflare Agent SDK provider switching

Nimbus treats provider/model selection as task-configurable and environment-configurable:

- Request-level: `provider`, `model`
- Env defaults:
  - `AGENT_PROVIDER`
  - `AGENT_MODEL`

Cloudflare Agent SDK integration uses:
- `provider = cloudflare_agents_sdk`
- `AGENT_SDK_URL` (required endpoint)
- optional `AGENT_SDK_AUTH_TOKEN`

The runtime sends step context (prompt/model/history/step counters) and expects an action envelope back (`tool` action or `final` result). This keeps provider switching isolated from tool/policy code.

## Feature flag and config

- Runtime gate: `workspace_agent_runtime_enabled`
  - Env: `WORKSPACE_AGENT_RUNTIME_ENABLED`
  - Runtime override key: `workspace_agent_runtime_enabled`
- Additional env controls:
  - `WORKSPACE_AGENT_MAX_RETRIES`
  - `WORKSPACE_AGENT_MAX_STEPS`
  - `WORKSPACE_AGENT_TIMEOUT_MS`

## Acceptance criteria

- Autonomous task can perform file edits and reach terminal `succeeded` with event trace.
- Cancellation request transitions running/queued tasks to coherent terminal behavior.
- Policy violations are blocked with explicit error codes.
- Idempotent re-run with same key+payload returns existing task without duplicate side effects.

## Test plan

- Unit:
  - queue payload parsing/validation
  - retry classification function
  - policy checks (command/path)
- Integration-style worker tests:
  - create -> run -> success with events
  - create missing idempotency -> 400
  - get events pagination inputs
  - cancel request path
  - idempotent create replay behavior

## Rollout

1. Ship dark (`workspace_agent_runtime_enabled=false`).
2. Enable in internal environments with `provider=scripted` first.
3. Enable Cloudflare Agent SDK provider in staging (`cloudflare_agents_sdk`).
4. Validate event quality, retries, and cancellation behavior.
5. Gradually expand to production workspaces.
