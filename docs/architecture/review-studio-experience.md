# Review Studio Experience Spec (v0.3)

Status: Draft approved for implementation handoff
Owner: Product + UX direction (captured via interactive interview)
Scope: End-to-end user experience and locked technical decisions needed to avoid implementation drift

## Why this document exists

The current review flow feels fragmented:

1. Write code
2. Commit
3. Entire checkpoint exists
4. Run `nimbus review open`
5. Do policy approval in terminal
6. Wait for review
7. View UI result
8. UI server may stop, requiring restart

This creates context switching and breaks momentum. This document defines a cohesive terminal-to-UI experience that another agent can implement without changing product intent.

## Product intent (north star)

Nimbus review should feel like one continuous loop:

- Open studio once
- Start a review quickly with safe defaults
- Observe progress with optional depth
- Act on findings
- Run another review after fixes

Terminal is optional after launch.

## Core design principles

1. Minimize decisions before starting a review.
2. Keep branch context visible and accurate.
3. Keep users on one continuous route during run lifecycle.
4. Prioritize recovery over diagnostics when failures happen.
5. Hide operational complexity unless user asks for detail.

## Final decisions from discovery interview

1. Initial page is Home with a dominant `New Review` CTA and recent reviews.
2. Home is a control center (not just a history inbox).
3. New review starts from a slide-over panel on Home.
4. Default target behavior assumes user wants latest checkpoint from current branch.
5. Policy approval can be skipped using an explicit mode/toggle.
6. Policy mode preference is sticky per repository.
7. Policy remains visible on the review page for reference.
8. Review lifecycle stays on one route (queued -> running -> completed/failed).
9. Progress view defaults to quiet summary, with "agent thinking" details available.
10. Failures emphasize retry/recovery actions first.
11. Parallel reviews are allowed.
12. Post-run primary actions are act on findings and run another review.
13. Visual tone starts as mission-control top layer + report-reader lower layer.
14. Terminal should be optional after studio launch.
15. Branch change while studio is open should require explicit context switch click (no automatic jump).
16. If no checkpoint exists at all, hard fail for now.
17. "Agent Thinking" defaults to curated summaries with raw stream toggle.
18. Secondary Home CTA should be `Resume active review` when applicable.
19. `Run another review` should prefill same branch + latest checkpoint.

## Information architecture

Three main surfaces:

1. Home (Studio control center)
2. New Review slide-over (over Home)
3. Review Run page (single morphing route)

No separate "waiting" page and no forced route swap on completion.

## Page 1: Home (Studio control center)

## Purpose

Provide immediate momentum and branch-aware context.

## Required content

- Current branch context (prominent)
- Dominant `New Review` CTA
- Secondary `Resume active review` CTA when active review exists
- Recent reviews list (latest 3) scoped to current branch
- Access to branch list view (secondary, not dominant)

## Behavior rules

- Home loads in context of current git branch.
- If branch changes while studio is open, show a non-blocking banner:
  - "Branch changed to `<new-branch>`. Switch context?"
  - Primary action: `Switch context`
  - No automatic context switch.

## Empty states

- No reviews on branch: show instructional empty state + `New Review` CTA.
- No active review: hide `Resume active review` and keep layout stable.

## Page 2: New Review slide-over

## Purpose

Start a review with minimal choices.

## Inputs and defaults

- Target defaults to "latest checkpoint on current branch".
- Use existing CLI-style checkpoint fallback behavior.
- If no checkpoint exists anywhere, hard fail (explicitly acceptable for v1).

## User choices (v1)

Only one meaningful choice:

- Policy mode:
  - `Auto policy` (skip manual approval)
  - `Review policy first`

Policy mode is sticky per repository.

## Preflight card

Before start, show concise preflight summary:

- Branch
- Resolved checkpoint target
- Policy mode
- Core readiness checks status

No advanced controls in this version.

## Start behavior

- `Start Review` transitions directly to the Review Run page.
- No terminal prompt dependence for policy confirmation in the primary path.

## Page 3: Review Run page (single morphing route)

## Purpose

Maintain continuity from start through completion.

## State progression

Same page morphs through:

- Queued
- Running
- Completed
- Failed

## Default layout behavior

- Quiet summary by default:
  - current stage
  - elapsed time
  - high-level confidence/progress signals

- Expandable `Agent Thinking` panel:
  - default: curated summaries
  - optional toggle: raw event stream

- Policy reference panel remains visible for traceability.

## Completion state

Primary actions:

1. `Act on findings`
2. `Run another review` (prefill same branch + latest checkpoint)

## Failure state

Recovery-first ordering:

1. `Retry same inputs`
2. `Retry with policy review`
3. Diagnostics and detailed logs below

## Branch awareness model

Branch awareness is first-class across Home and review creation:

- Current branch anchors default behavior.
- Branch list view remains available for cross-branch review browsing.
- Branch switches are explicit, not automatic.

## Parallel review model

- Parallel reviews are allowed.
- UI must maintain clear association of each run with branch and target.
- Do not block parallel starts by default.

## Policy experience model

Two policy modes are productized:

- Auto policy: fastest path, no manual approval step.
- Review policy first: manual approval before run start.

Policy is always visible during/after run for user trust and auditability.

## "Discuss finding" extension (planned, not in v1)

Desired future behavior:

- User can ask follow-up questions on a finding.
- System can refine explanation and suggested fix.
- May include external research support in later phase.

For v1 this is explicitly out of scope, but design should leave room in completed review layout.

## Worktree guidance (experience-level)

Git worktrees are the default backing model for review environments.

Product framing guidance:

- Treat worktrees as an implementation detail in v1.
- Do not expose "worktree" as required user vocabulary.
- If surfaced later, describe as "isolated review environment".

## Locked technical decisions

This section is normative for implementation agents.

## Platform and boundary assumptions

1. Runtime stack remains Cloudflare-based backend + OpenRouter inference.
2. Studio control plane is local (CLI-managed local server + browser UI).
3. Worker remains the execution backend and source of review-run truth.

## Local vs worker responsibility split

Keep this split unchanged unless explicitly re-approved:

- Local Studio owns:
  - current-branch detection
  - commit/checkpoint resolution
  - Entire discovery/processing
  - local co-change resolution
  - normalized provenance/context assembly

- Worker owns:
  - policy derivation and approval state transitions
  - review run lifecycle state transitions
  - durable persistence for runs/events/policies
  - queue/execution orchestration

Important clarification:

- We are not moving Entire discovery to worker in this phase.
- Worker derives policy from context payload received from local Studio.

## Event transport

Use hybrid transport:

1. Worker -> Studio: SSE (existing review events stream)
2. Studio -> Browser: WebSocket for interactive UI updates
3. Browser fallback: SSE/poll as resilience path if WebSocket fails

`Agent Thinking` behavior mapping:

- curated summaries: default visible stream in UI
- raw stream: optional toggle sourced from same event feed

## Auth and key handling

OpenRouter key precedence:

1. request-level override key
2. environment fallback key

Security requirements:

- never persist API keys in repo-local config
- redact key-like values from logs/events/errors
- do not echo secrets in UI diagnostic surfaces

## Repo-local preference persistence

Persist Studio preferences in repo-local config:

- path: `.nimbus/studio.json`
- tracked by git: no (must be ignored)
- includes: policy mode preference (sticky per repo), lightweight UI prefs as needed
- must be schema-versioned for forward migration

## Branch change detection

Default strategy:

- poll git branch state (`.git/HEAD` resolution equivalent) about every 2 seconds
- debounce UI banner updates to avoid flicker
- require explicit user click to switch context

## Start idempotency and dedupe

New review start must be idempotent:

1. UI disables primary start CTA after first click
2. Studio generates idempotency key per launch attempt
3. Worker dedupes duplicate starts by idempotency key

## Worktree lifecycle model (required)

Default model: `ephemeral by default, durable by intent`.

All Studio-started reviews use detached-HEAD ephemeral worktrees.

Worktree modes:

1. `review` mode (default)
   - created automatically per run
   - short retention window
   - cleanup-eligible when safe
2. `edit` mode (promoted)
   - retained for follow-up code changes
   - longer retention window
   - not auto-cleaned aggressively

Promotion rules:

- user can explicitly promote to `edit`
- system may auto-promote if mutable follow-up workflow starts and changes are present

Cleanup guardrails:

- never delete active or pinned environments
- never delete environments with unexported/unresolved edits
- perform startup sweeps for stale `review` environments only
- support explicit user actions: keep, archive, cleanup

Metadata requirements per environment:

- mode (`review` | `edit`)
- createdAt
- lastTouchedAt
- pinned flag
- parent review id
- branch/ref provenance

## Implementation appendix: contracts and defaults

This appendix is intentionally concrete so implementation agents can execute without guessing.

## A) Studio -> Worker start payload contract

Studio sends a single normalized payload for policy/run start.

```json
{
  "idempotencyKey": "studio-start-<uuid>",
  "target": {
    "type": "workspace_deployment",
    "workspaceId": "ws_abc12345",
    "deploymentId": "dep_abc12345"
  },
  "mode": "report_only",
  "policyMode": "auto|review_first",
  "provenance": {
    "repo": "owner/repo",
    "branch": "feature/x",
    "commitSha": "<40-char sha>",
    "note": "optional",
    "sessionIds": ["ses_x"],
    "transcriptUrl": null,
    "intentSessionContext": ["string"],
    "rawSessionPrompts": "string",
    "contextResolution": "direct|branch_fallback",
    "contextResolutionOriginalCheckpointId": "chk_original",
    "contextResolutionResolvedCheckpointId": "chk_resolved",
    "contextResolutionResolvedCommitSha": "<40-char sha>",
    "contextResolutionResolvedCommitMessage": "commit subject",
    "localCochange": {
      "source": "local_git",
      "checkpointsRef": "entire/checkpoints/v1",
      "lookbackSessions": 10,
      "topN": 20,
      "sessionsScanned": 8,
      "relatedByChangedPath": {}
    }
  },
  "requestedBy": {
    "surface": "studio_ui",
    "studioSessionId": "st_abc123"
  }
}
```

Contract rules:

1. Studio is the source of truth for branch/checkpoint/Entire/co-change fields.
2. Worker must not attempt local git/Entire discovery in this flow.
3. Worker stores provenance as received (with normal validation/sanitization).

## B) Worker -> Studio event envelope (SSE)

Canonical envelope:

```json
{
  "seq": 42,
  "createdAt": "2026-04-01T12:34:56.000Z",
  "reviewId": "rev_abc12345",
  "type": "review_progress",
  "status": "queued|running|succeeded|failed|cancelled",
  "stage": "policy|queue|analysis|finalize",
  "message": "human-readable progress",
  "details": {}
}
```

Terminal event (required):

```json
{
  "seq": 99,
  "createdAt": "2026-04-01T12:39:56.000Z",
  "reviewId": "rev_abc12345",
  "type": "terminal",
  "status": "succeeded"
}
```

Failure event (required fields):

```json
{
  "seq": 77,
  "createdAt": "2026-04-01T12:37:12.000Z",
  "reviewId": "rev_abc12345",
  "type": "review_failed",
  "status": "failed",
  "error": {
    "code": "review_context_cochange_failed",
    "message": "redacted message"
  }
}
```

## C) Studio -> Browser WebSocket envelopes

Studio forwards two channels from the same source stream.

Curated (default visible):

```json
{
  "channel": "curated",
  "reviewId": "rev_abc12345",
  "seq": 42,
  "status": "running",
  "stage": "analysis",
  "summary": "Review agent is analyzing changed files (pass 2/3).",
  "timestamp": "2026-04-01T12:35:11.000Z"
}
```

Raw (toggle):

```json
{
  "channel": "raw",
  "reviewId": "rev_abc12345",
  "seq": 42,
  "event": {}
}
```

Curation rules:

1. Curated summaries are derived from worker events only.
2. Do not invent synthetic completion/failure states.
3. Redaction rules apply equally to curated and raw channels.

## D) Idempotency behavior contract

1. UI disables `Start Review` after first click until acknowledgement.
2. Studio always generates and sends a per-attempt idempotency key.
3. Worker returns existing run when idempotency key already exists.
4. Studio treats duplicate response as success and routes to existing review.

## E) Worktree retention defaults (locked)

Mode defaults:

- `review` mode TTL: 24 hours since `lastTouchedAt`
- `edit` mode TTL: 14 days since `lastTouchedAt`

Sweep behavior:

1. Run sweep on Studio startup and every 6 hours.
2. Sweep only `review` mode by default.
3. `edit` mode is sweep-eligible only after TTL and only if not pinned.

Never auto-delete when any of the following is true:

1. environment is active/locked by running session
2. environment is pinned
3. unexported edits are detected
4. mode is `edit` and TTL has not elapsed

Recommended explicit actions surfaced in UI:

1. `Keep environment` (sets pinned)
2. `Promote to edit session`
3. `Archive and cleanup`

## F) Minimal repo-local config shape

Path: `.nimbus/studio.json` (must be gitignored)

```json
{
  "version": 1,
  "review": {
    "policyMode": "auto"
  },
  "ui": {
    "showRawThinkingByDefault": false
  }
}
```

Constraints:

1. No secrets in this file.
2. Unknown keys tolerated for forward compatibility.
3. Invalid file falls back to safe defaults and logs a warning.

## Non-goals for this phase

1. No framework migration decision in this spec (e.g., TanStack Start).
2. No advanced review configuration surface.
3. No redesign of every analytics/history surface before the core loop works.
4. No attempt to handle "no checkpoint at all" beyond explicit hard fail.

## Definition of seamless (experience acceptance)

The experience is considered cohesive when:

1. User can launch studio and complete one review cycle without returning to terminal prompts.
2. User can start a second review after fixes in one click from completed state.
3. Branch context is obvious and never silently changes.
4. Progress is understandable at a glance, with optional deep visibility.
5. Failure path offers immediate retry options without forcing page/context reset.

## Handoff notes for implementation agents

This document intentionally captures UX behavior, not low-level architecture. During implementation planning:

- Preserve these experience decisions unless explicitly revised.
- If technical constraints require deviations, record them as decision notes before coding.
- Keep language consistent with this spec (`Home`, `New Review`, `Review Run`, `Agent Thinking`, `Resume active review`).

## Remaining open items (not blockers)

1. Exact retention durations for `review` and `edit` worktree modes.
2. UI affordance details for keep/archive/cleanup actions.
3. Optional future exposure of environment internals for power users.
