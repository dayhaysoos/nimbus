# Phase 2: Code View and Diff

## Objective
Expose workspace code and diff visibility so users can inspect state before exporting, forking, or deploying.

## In scope
- File tree listing and file read APIs.
- Diff APIs against baseline and optionally against HEAD source.
- File watch stream for workspace change updates.
- CLI commands for file inspect and diff output.

## Out of scope
- Full browser IDE editing.
- Branch fork and zip export.
- Agent workflows beyond basic manual edits.

## User stories
1. As a developer, I can list files in workspace and read any file safely.
2. As a developer, I can view the current diff from baseline.
3. As a developer, I can subscribe to file change events.

## Deliverables
- Worker APIs:
  - `GET /api/workspaces/:id/files?path=`
  - `GET /api/workspaces/:id/file?path=`
  - `GET /api/workspaces/:id/diff`
  - `GET /api/workspaces/:id/watch` (SSE)
- Diff generation:
  - file-level summary + patch text support
  - rename/deletion handling
- CLI:
  - `nimbus workspace files <id> [path]`
  - `nimbus workspace cat <id> <path>`
  - `nimbus workspace diff <id>`

## API contract notes
- Read endpoints must enforce workspace-root-safe paths.
- Diff response shape should include:
  - file counts (added/modified/deleted)
  - changed file list
  - optional unified diff payload
- Watch stream should emit normalized events with monotonic sequence numbers.

## Acceptance criteria
- File list/read cannot escape workspace root.
- Diff output is stable for repeated calls when no changes occur.
- Watch stream emits create/modify/delete/move events and reconnect is supported.
- Large file handling has explicit truncation or pagination policy.

## Test plan
- Unit: path normalization and traversal rejection.
- Unit: diff formatter behavior for add/delete/rename.
- Integration: edit file -> diff reflects exact change.
- Integration: watch stream emits expected events from filesystem actions.

## Rollout
- Feature flag: `workspace_diff_enabled`.
- Start with CLI consumption first; UI can build against stable API.

## Interview focus for this phase
- Diff format preference (raw patch vs structured hunks).
- Max payload policy and pagination for very large diffs.
- Watch stream reconnect semantics and replay window.
