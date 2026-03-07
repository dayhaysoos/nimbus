# Phase 2: Code View and Diff

## Objective
Expose workspace code and diff visibility so users can inspect state before exporting, forking, or deploying.

## In scope
- File tree listing and file read APIs.
- Diff APIs against baseline and optionally against HEAD source, generated server-side with `simple-git`.
- Diff output contracts with structured metadata by default and optional unified patch payloads.
- Large diff truncation policy with caller-controlled `max_bytes` limits (no pagination in Phase 2).
- File watch stream for workspace change updates with SSE reconnect/replay semantics.
- Client-side diff rendering integration contract for `diff2html`.
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
  - `GET /api/workspaces/:id/diff?include_patch=true&max_bytes=`
  - `GET /api/workspaces/:id/watch` (SSE)
- Diff generation:
  - server-side generation using `simple-git`
  - file-level summary metadata by default (counts, changed file list, per-file status)
  - rename/deletion handling
  - optional unified patch text gated by `include_patch=true`
  - truncation behavior with explicit `truncated: true` and `max_bytes` support
- Diff rendering:
  - client-side rendering contract for `diff2html`
- CLI:
  - `nimbus workspace files <id> [path]`
  - `nimbus workspace cat <id> <path>`
  - `nimbus workspace diff <id>`

## API contract notes
- Read endpoints must enforce workspace-root-safe paths.
- Diff response shape should include:
  - file counts (added/modified/deleted/renamed)
  - changed file list with per-file status metadata
  - optional unified diff payload only when `include_patch=true`
  - truncation metadata: `truncated: true|false`
- Diff endpoint supports `max_bytes` query param to bound response size.
- For oversized file diffs, `GET /api/workspaces/:id/file?path=` is the escape hatch for targeted inspection.
- Pagination is explicitly out of scope for Phase 2.
- Watch stream should emit normalized events with monotonic sequence numbers.
- SSE reconnect uses `Last-Event-ID` with the caller's last seen sequence number.
- Server replay buffer target is the smaller of: last 100 events or last 60 seconds.
- If reconnect falls beyond replay buffer, server emits `sequence_gap` event and client performs full resync via `/files` and `/diff`.

## Acceptance criteria
- File list/read cannot escape workspace root.
- Diff output is stable for repeated calls when no changes occur.
- Diff output includes structured metadata by default, with patch payload only when `include_patch=true`.
- Rename and deletion detection are correct for workspace git state.
- Large diff responses honor truncation policy with explicit `truncated` signaling and `max_bytes` control.
- Watch stream emits create/modify/delete/move events and supports reconnect with `Last-Event-ID` replay.
- Replay-gap reconnects emit `sequence_gap` and clients can recover via `/files` + `/diff` resync.

## Test plan
- Unit: path normalization and traversal rejection.
- Unit: diff formatter behavior for add/delete/rename and structured metadata mapping.
- Unit: `include_patch` toggle and `max_bytes` truncation behavior.
- Integration: edit file -> diff reflects exact change.
- Integration: large diff payloads return `truncated: true` and bounded output.
- Integration: `GET /api/workspaces/:id/file?path=` remains usable for large files when diff is truncated.
- Integration: watch stream emits expected events from filesystem actions.
- Integration: SSE reconnect with `Last-Event-ID` replays buffered events.
- Integration: stale reconnect beyond replay buffer receives `sequence_gap` and resync succeeds.

## Rollout
- Feature flag: `workspace_diff_enabled`.
- Start with CLI consumption first; UI can build against stable API.

## Interview focus for this phase
- Diff format preference (raw patch vs structured hunks).
- Max payload policy and pagination for very large diffs.
- Watch stream reconnect semantics and replay window.
