# Workspace Flow

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe how workspaces are created, hydrated, inspected, reset, and deleted.

## Trigger Paths

- Workspace creation: the CLI resolves a checkpoint or commit-ish locally, archives source from git, then calls `POST /api/workspaces` with a source bundle and metadata.
- Workspace inspection: clients call worker endpoints such as `GET /api/workspaces/:id`, `GET /api/workspaces/:id/files`, `GET /api/workspaces/:id/file`, `GET /api/workspaces/:id/diff`, and `GET /api/workspaces/:id/events`.
- Workspace reset: clients call `POST /api/workspaces/:id/reset` to restore sandbox contents from the persisted source bundle.
- Workspace deletion: clients call `DELETE /api/workspaces/:id` to destroy the sandbox and remove the stored source bundle.

## High-Level Steps

1. Source resolution
2. Workspace record creation
3. Sandbox hydration
4. File/diff access
5. Optional follow-on operations
6. Reset or delete

Current implementation details:

1. The CLI resolves commit SHA, checkpoint trailer, source ref, and optional project root using local git helpers.
2. The CLI builds a source archive and uploads it to the worker as multipart form data.
3. The worker stores the bundle in R2 and creates the workspace record in D1.
4. The worker hydrates the sandbox filesystem from the uploaded tarball into `/workspace`.
5. The worker tries to initialize a git baseline so future diff operations can compare against `HEAD`.
6. If baseline initialization succeeds or fails, the workspace is transitioned to `ready`, with `baselineReady` recording whether diff/reset semantics are fully available.
7. File listing, file reads, and diffs are served live out of the sandbox, with path validation and byte limits enforced in the worker.
8. Additional workspace operations exist for exports, GitHub fork, deployments, and agent tasks, but the base workspace lifecycle is create -> inspect -> mutate externally -> diff/reset/delete.

## Inputs And Outputs

- Inputs:
  - source bundle tarball
  - source metadata including commit SHA, optional checkpoint ID, optional source ref, and optional project root
  - workspace ID in follow-on operations
- Outputs:
  - workspace resource metadata, including status, source metadata, sandbox ID, and baseline readiness
  - file content and directory entries
  - diff summary and optional patch
  - workspace event history
- Artifacts:
  - source bundle stored in R2
  - optional exported artifacts recorded in workspace artifact APIs

## State Model

- States:
  - `creating`
  - `ready`
  - `failed`
  - `deleted`
- Terminal states:
  - `failed`
  - `deleted`
- Important transitions:
  - create path: `creating -> ready` or `creating -> failed`
  - reset path: effectively rehydrates and re-establishes `ready`
  - delete path: current resource transitions to `deleted` after sandbox and bundle cleanup succeed
  - `baselineReady` is an important secondary state: a workspace can be `ready` while still lacking a valid git baseline for diff operations

## Failure Modes

- Source bundle upload or workspace creation bookkeeping fails before the workspace is fully created.
- Sandbox hydration succeeds but git baseline initialization fails, leaving the workspace `ready` with `baselineReady = false`.
- Reset or delete can partially fail if the sandbox or stored source bundle cannot be reconciled cleanly.

## Non-Regression Expectations

- Workspace creation must continue persisting the uploaded source bundle and hydrating the sandbox from that exact bundle.
- File and diff endpoints must continue enforcing path safety and byte limits.
- Reset must continue rebuilding the sandbox from the original stored source bundle rather than from the current mutated state.

## Current Implementation References

- `packages/cli/src/commands/workspace/create.ts`
- `packages/cli/src/commands/workspace/show.ts`
- `packages/worker/src/api/workspaces.ts`
- `packages/worker/src/lib/db.ts`
- `packages/worker/src/lib/workspace-deployment-runner.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`

## Refactor Notes

- Separate route handling from sandbox operations, persistence, and provider-specific behavior.
