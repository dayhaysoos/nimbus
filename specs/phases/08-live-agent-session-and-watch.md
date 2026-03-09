# Phase 8: Live Agent Session and Watch UX

## Objective
Provide a first-class real-time experience for sandbox tasks and deployments so users can watch progress, ask follow-up questions, and understand what happened without manual endpoint polling.

## Why this phase exists
Current APIs expose rich events, but operator ergonomics still depend on separate commands and manual interpretation. The target experience is a continuous, readable "checkpoint -> agent task -> deploy" session.

## Product decisions (proposed final)
1. **Event stream first:** use server-sent events for workspace task and deployment event tails.
2. **Single watch surface:** CLI supports one command to stream task + deploy timeline.
3. **Readable by default:** collapse noisy internal events; keep drill-down available.
4. **Cloudflare-native transport:** use streaming HTTP/SSE from Worker (no WebSocket requirement in v1).
5. **Replay model:** support `since` cursor and `lastEventId` resume; store canonical events in D1.
6. **Replay retention window:** keep watch replay history for 72 hours.
6. **Session boundary:** one session binds to `workspaceId` and optionally `taskId`/`deploymentId`.
7. **Failure UX:** always show normalized `nextAction` in terminal footer for terminal failures.
8. **Default view:** show grouped, expandable summaries by default; raw firehose remains opt-in.

## In scope
- Unified event stream endpoint(s).
- CLI `watch` enhancements for workspace task/deploy contexts.
- Session correlation (`workspaceId`, `taskId`, `deploymentId`, `operationId`).
- Stable terminal rendering for long-running sessions.
- Keepalive heartbeat events and reconnect guidance for unstable networks.
- Bounded payloads with summary/detail split to keep watch output readable.

## Out of scope
- Browser GUI dashboard.
- Multi-user collaborative cursors/chat UI.

## Deliverables

### D1. Session timeline model
- Normalized event envelope:
  - `sessionId`
  - `scope` (`task|deployment|workspace`)
  - `phase`
  - `summary`
  - `details`
  - `timestamp`
  - `cursor`
  - `nextAction` (optional)

Envelope example:
```json
{
  "sessionId": "ses_ws_abc123",
  "cursor": 128,
  "scope": "deployment",
  "phase": "running",
  "summary": "Toolchain bootstrap succeeded",
  "details": { "manager": "pnpm", "version": "9.15.0" },
  "nextAction": null,
  "timestamp": "2026-03-10T01:23:45.000Z"
}
```

### D2. Worker stream endpoint
- New stream endpoint for correlated workspace activity.
- Resume support (`lastEventId`).
- Endpoint contract (v1):
  - `GET /api/workspaces/:id/stream?task_id=<id>&deployment_id=<id>&since=<cursor>`
  - SSE events: `snapshot`, `event`, `heartbeat`, `terminal`, `error`

### D3. CLI watch improvements
- `nimbus workspace watch <workspace-id> [--task <id>] [--deploy <id>]`
- Human-readable grouped updates.
- Terminal footer with next actions on failure.
- Optional flags:
  - `--since <cursor>`
  - `--raw`
  - `--heartbeat-timeout-ms <n>`

## Acceptance criteria
- Users can observe task + deploy lifecycle from one command.
- Stream reconnect does not lose continuity.
- Failure guidance appears inline in watch output.
- A dropped connection can reconnect and continue using cursor within 5s without duplicate terminal output.
- Watch output remains under 1 line/sec average during idle heartbeat periods.

## Implementation checklist
1. Add session correlation IDs to relevant events.
2. Add stream API for correlated events.
3. Add CLI watch command for workspace sessions.
4. Add tests for reconnect/resume behavior.
5. Document operator workflow in `specs/testing/`.
6. Add heartbeat/timeout logic and CLI recovery messaging.
7. Add pagination/snapshot fallback when stream endpoint is unavailable.
