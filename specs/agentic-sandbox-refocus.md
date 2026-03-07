# Nimbus Refocus: Agentic Sandbox First

## Status
- Date: 2026-03-07
- Decision: Refocus Nimbus from deploy-first to sandbox-first workflows.
- Git provider scope: GitHub only (v1).

## Why this refocus
Nimbus already has solid checkpoint ingestion and sandbox build-validation primitives. What users now need most is a safe place to experiment on a checkpoint before changing local or remote repos.

The product center shifts to:

`checkpoint -> sandbox workspace -> inspect code/diff -> export or fork -> optional deploy`

## Product thesis
If a user can open a deterministic sandbox from an Entire checkpoint, iterate with agents, and export changes safely (zip/branch), they can decide with confidence before resetting locally.

## Core product principles
1. Agentic first: first-class support for LLM/agent-driven code changes inside sandbox workspaces.
2. Checkpoint provenance: every workspace ties back to checkpoint ID + commit SHA.
3. Determinism over convenience: explicit source snapshot, explicit diffs, explicit exports.
4. Safe by default: scoped credentials, audit events, and constrained command execution.
5. Deploy is downstream: deployment remains important, but follows sandbox experimentation.

## V1 scope
- Create persistent sandbox workspaces from checkpoint/commit source.
- View code and file tree in workspace.
- Compute and view diffs against baseline snapshot.
- Export workspace changes as zip (and optional patch).
- Fork to GitHub branch from workspace changes.

## V1 non-goals
- Multi-provider git integrations.
- Full browser IDE parity with local editors.
- Broad deploy target matrix.
- Perfectly generic SCM abstractions.

## Platform fit (Cloudflare)
- Sandbox SDK provides command execution, file APIs, terminal/websocket, file watching, and backup/restore primitives.
- Durable Objects + D1 fit stateful workspace coordination.
- R2 fits source bundles, workspace exports, and backup artifacts.
- Agents SDK and Workflows support autonomous and durable multi-step agent tasks.

## High-level architecture
1. Resolve checkpoint/commit from repo history and metadata.
2. Materialize workspace in sandbox from source bundle.
3. Create baseline backup handle for fast reset/diff origin.
4. Expose workspace APIs for file browsing, read, watch, diff, and events.
5. Run agent tasks against workspace via constrained tool surface.
6. Export as zip/patch or fork to GitHub branch.
7. Optional deploy from selected workspace state.

## Data model direction
Add new workspace-focused records in D1:
- `workspaces`
  - identity, owner, repo ref, checkpoint provenance, sandbox ID, lifecycle timestamps.
  - baseline backup handle metadata.
- `workspace_events`
  - sequenced event log for UI replay/audit.
- `workspace_artifacts`
  - exported zips/patches, generated metadata, retention policy.
- `workspace_tasks` (agent execution)
  - queued/running/completed/failed task state + outputs.

## Security model direction
- GitHub-only OAuth/App integration for fork/branch actions.
- Principle of least privilege for tokens.
- Sandbox command policy allowlist/denylist.
- Secret redaction in logs/events.
- Explicit user intent gates for irreversible actions (e.g., push/merge).

## Success metrics (initial)
- Time-to-first-workspace from checkpoint.
- Workspace task completion rate.
- Diff inspect to export/fork conversion.
- Error rate by phase (workspace create, diff, export, fork).
- Median runtime/cost per workspace lifecycle.

## Phase map
- Phase 1: Workspace foundation.
- Phase 2: Code view + diff.
- Phase 3: Export zip + GitHub branch fork.
- Phase 4: Agentic runtime.
- Phase 5: Deploy from workspace.

See phase specs in `specs/phases/`.

## Risks and mitigations
- Sandbox lifecycle/state loss: use backup handles and deterministic restore paths.
- Credential misuse risk: use scoped app tokens + explicit operation policies.
- Large diffs/artifacts: enforce limits and chunked retrieval.
- Long-running tasks: route through queue/workflow with retries and idempotency keys.

## Open questions
- Workspace TTL defaults and cleanup policy.
- Max workspace size and export limits for v1.
- Reset semantics (hard reset to baseline vs selective rollback).
- Granularity for diff APIs (file-by-file, hunk-level, full patch).
