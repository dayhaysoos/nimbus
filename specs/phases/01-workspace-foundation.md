# Phase 1: Workspace Foundation

## Objective
Create a persistent sandbox workspace from checkpoint provenance, with deterministic bootstrap and reset-ready baseline state.

## In scope
- Workspace create/get/delete lifecycle.
- Source materialization from checkpoint bundle.
- Baseline snapshot handle creation for restore/reset.
- Workspace event stream scaffolding.
- Minimal CLI command surface for workspace bootstrap and status.

## Out of scope
- Rich code browsing UX.
- Diff and export UX.
- Agent task orchestration.
- Deployment from workspace.

## User stories
1. As a developer, I can create a workspace from checkpoint ID or commit SHA.
2. As a developer, I can reopen an existing workspace and keep working.
3. As a developer, I can destroy a workspace and clean up resources.
4. As a developer, I can reset to baseline (initially API-only is acceptable).

## Deliverables
- D1 schema additions:
  - `workspaces`
  - `workspace_events`
- Worker APIs:
  - `POST /api/workspaces`
  - `GET /api/workspaces/:id`
  - `DELETE /api/workspaces/:id`
  - `POST /api/workspaces/:id/reset` (baseline restore)
- Sandbox behavior:
  - Deterministic unpack into workspace directory.
  - Baseline backup handle created and persisted.
- CLI:
  - `nimbus workspace create ...`
  - `nimbus workspace show <id>`
  - `nimbus workspace destroy <id>`

## API contract notes
- Workspace create input must include source provenance:
  - `checkpointId` (nullable)
  - `commitSha` (required)
  - optional `projectRoot`, `ref`
- Response should include:
  - workspace ID, status, sandbox ID, createdAt, baselineReady, events URL

## Acceptance criteria
- Creating workspace from valid checkpoint creates one persistent record and one baseline backup handle.
- Invalid source metadata fails fast with clear error.
- Reset endpoint restores to baseline successfully for modified files.
- Destroy endpoint removes workspace state and prevents further operations.
- Event log includes at least: created, baseline_created, reset, destroyed, failed.

## Test plan
- Unit: metadata parsing, DB mapping, state transitions.
- Integration: create -> mutate -> reset -> verify baseline restored.
- Integration: create -> destroy -> read returns not found.
- Failure path: backup creation failure cleanly marks workspace failed.

## Rollout
- Feature flag: `workspace_v1_enabled`.
- Internal-only endpoint exposure first.
- Add retention cleanup job once basic lifecycle is stable.

## Interview focus for this phase
- Workspace ownership model and auth boundary.
- ID semantics and idempotency behavior.
- Baseline snapshot timing and error handling policy.
