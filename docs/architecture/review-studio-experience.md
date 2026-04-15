# Review Studio Experience Spec (v0.3)

Status: Locked product spec, implementation in progress
Owner: Product + UX direction (captured via interactive interview)
Scope: End-to-end user experience and locked technical decisions needed to avoid implementation drift

## Implementation status

This file is the stable product spec for Review Studio.

Use `review-studio-implementation-plan.md` for current rollout status and slice-by-slice delivery tracking.

Current snapshot as of 2026-04-11:

- Slice 0 foundation: partial
- Slice 1 Home: shipped
- Slice 2 New Review slide-over: shipped
- Slice 3 Review Run pre-run policy states: shipped with caveats
- Slice 4 Review Run active states: partial
- Slice 5 terminal actions and fix loop: not started
- Slice 6 hardening: not started

This file should change only when product intent changes. It should not be used as a status board.

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

## Command taxonomy (locked)

Studio and review creation are separate concepts. Keep the CLI surface aligned to that split.

Primary commands:

1. `nimbus review studio`
   - opens or reuses the local Studio control plane and browser UI
   - does not create a review by default
   - may optionally support direct navigation to an existing review route

2. `nimbus review create`
   - always creates a review workflow
   - may create the review directly or create a policy-first review that waits for approval, depending on policy mode
   - remains valid for CLI-first, CI, and Studio-assisted flows

Policy mode contract for `nimbus review create`:

- `--policy-mode none`
  - no policy derivation step
  - create and enqueue the review directly
  - this is the fast path and should preserve current non-policy behavior

- `--policy-mode auto`
  - derive policy from checkpoint/context payload
  - auto-approve the derived policy
  - enqueue review without manual policy edit step

- `--policy-mode review`
  - derive policy from checkpoint/context payload
  - require user review/edit/approval before enqueueing review execution

Sugar flags:

- `--auto-policy` -> alias for `--policy-mode auto`
- `--policy` -> alias for `--policy-mode review`

Flag rules:

1. `--policy-mode` is the canonical interface.
2. Sugar flags must map to the same internal enum as `--policy-mode`.
3. Passing conflicting policy flags is a CLI usage error.
4. Default behavior when no explicit policy flag is provided:
   - bare `nimbus review create` defaults to `--policy-mode none`
   - Studio-created reviews use the saved repo preference from `.nimbus/studio.json` when present
   - if no saved Studio preference exists yet, Studio defaults to `--policy-mode auto`
5. These defaults must be documented in CLI help and remain stable unless explicitly changed.

Compatibility guidance:

- `nimbus review open` is no longer the primary product concept for Studio.
- Keep `review open` only as a compatibility alias during transition.
- Preferred compatibility target:
  - either `nimbus review studio`
  - or `nimbus review create --policy-mode review --open-studio`
- New docs and UI copy should stop teaching `review open` as the main path.

Optional UX flag:

- `--open-studio`
  - valid on `nimbus review create`
  - after the create/policy-start request succeeds, open or reuse Studio and route to the correct review or policy page
  - useful for users who start from terminal but want the rest of the loop in UI

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

All Studio-started reviews use isolated ephemeral environments anchored to a checkpoint-derived source snapshot.

Implementation note:

- local worktrees may still be used under the hood where helpful
- user-facing product language should prefer `environment` or `workspace`, not `worktree`
- the checkpoint/commit anchor remains immutable; mutable follow-up changes happen in a derived environment

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
- anchor checkpoint id
- anchor commit SHA
- branch/ref provenance

Review basis model:

1. `checkpoint` basis
   - initial review basis
   - environment is created from checkpoint-derived source snapshot
   - review findings and provenance are anchored to immutable checkpoint context

2. `environment` basis
   - follow-up review basis after agent edits
   - review analyzes current mutable environment state
   - default diff/provenance view still references original checkpoint anchor unless a more specific comparison is explicitly requested

## Implementation appendix: contracts and defaults

This appendix is intentionally concrete so implementation agents can execute without guessing.

## A) Studio -> Worker start payload contract

Studio sends a single normalized payload for policy/run start.

```json
{
  "idempotencyKey": "studio-start-<uuid>",
  "reviewBasis": "checkpoint|environment",
  "target": {
    "type": "workspace_deployment",
    "workspaceId": "ws_abc12345",
    "deploymentId": "dep_abc12345"
  },
  "mode": "report_only",
  "policyMode": "none|auto|review",
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
4. `reviewBasis = checkpoint` is the default for fresh review creation.
5. `reviewBasis = environment` is used for follow-up validation reviews against mutable environment state.

## B) Worker -> Studio event envelope (SSE)

Canonical envelope:

```json
{
  "seq": 42,
  "createdAt": "2026-04-01T12:34:56.000Z",
  "reviewId": "rev_abc12345",
  "type": "review_progress",
  "status": "policy_pending|policy_ready|policy_approved|queued|running|succeeded|failed|cancelled",
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

## G) State -> UI mapping (normative)

The Review Run route is a single route with state-specific panels and actions.

| Worker state | Default route behavior | Visible panels | Primary actions | Navigation behavior |
| --- | --- | --- | --- | --- |
| `policy_pending` | Stay on Review Run route in pre-run state | branch/context header, policy status, quiet progress, policy reference panel | none required; wait for derivation | no route swap |
| `policy_ready` | Stay on Review Run route in approval state | branch/context header, editable policy panel, derived policy reference, quiet progress | `Approve policy`, `Cancel` | no route swap |
| `policy_approved` | Stay on Review Run route in handoff state | branch/context header, approved policy panel, quiet progress | none required; queue handoff proceeds automatically | no route swap |
| `queued` | Stay on Review Run route in active state | branch/context header, quiet progress, policy reference, optional Agent Thinking panel | `Cancel` when supported | no route swap |
| `running` | Stay on Review Run route in active state | branch/context header, quiet progress, policy reference, Agent Thinking, event/activity log | no primary mutation by default; `Cancel` when supported | no route swap |
| `succeeded` | Stay on Review Run route in completed state | summary/report, findings, provenance, policy reference, environment status | `Fix with agent`, `Run another review`, `Export/apply locally` | no forced navigation on completion |
| `failed` | Stay on Review Run route in failed state | failure summary, recovery-first actions, diagnostics below, policy reference when available | `Retry same inputs`, `Retry with policy review` | no forced navigation on failure |
| `cancelled` | Stay on Review Run route in terminal cancelled state | cancellation summary, last known progress, policy/reference context | `Run another review` | no forced navigation on cancellation |

State rules:

1. The route never changes automatically because of status transition.
2. `policy_pending`, `policy_ready`, and `policy_approved` are first-class UI states, not implementation details.
3. `cancelled` is a terminal user-visible state and must not be collapsed into `failed`.

## H) User action -> backend effect (normative)

| User action | Creates new review run? | Reuses existing review? | Environment effect | Backend/system effect |
| --- | --- | --- | --- | --- |
| `Start Review` from Studio | yes | no | creates review-mode environment when needed for the initial run | resolves checkpoint/context, creates review workflow using Studio-selected policy mode |
| `Resume active review` | no | yes | reuses existing active environment | reconnects UI to existing review/policy route and resumes live status |
| `Approve policy` | no | yes | no new environment | advances existing review from `policy_ready` to queued execution |
| `Retry same inputs` | yes | no | creates a fresh review run; may reuse the same approved policy snapshot if the failed run already had one | replays prior effective inputs against a new run id |
| `Retry with policy review` | yes | no | creates a fresh review run in review-mode policy flow | starts new run with `policy-mode review` regardless of prior mode |
| `Run another review` | yes | no | creates a fresh review-mode environment from the latest resolved checkpoint on the same branch | starts a new checkpoint-based review flow using current Studio policy preference |
| `Fix with agent` | no | yes | creates or reuses a mutable edit-mode child environment derived from the anchor checkpoint/review environment | opens follow-up agent task flow for finding remediation; no new review run yet |
| `Review current environment` / `Validate fixes` | yes | no | reuses the current mutable environment | starts a new review run with `reviewBasis = environment` against current environment state |
| `Keep environment` | no | yes | sets environment pinned | updates retention metadata only |
| `Promote to edit session` | no | yes | changes environment mode from `review` to `edit` when safe | updates retention and mutability semantics only |
| `Archive and cleanup` | no | yes | archives exported state then destroys cleanup-eligible environment | persists export/cleanup audit trail, then removes environment when guards pass |
| `Export/apply locally` | no | yes | no change to review run; may mark environment as exported | explicit user-triggered export/apply path from environment to local repo; never implicit |

Action rules:

1. `Retry same inputs` and `Run another review` always create new review ids.
2. `Fix with agent` does not create a new review run; it transitions into an agent remediation loop on a mutable environment.
3. `Review current environment` must review the mutable environment state, not the original checkpoint snapshot.
4. `Run another review` must resolve the latest checkpoint again and must not silently reuse the prior mutable environment.
5. User-facing copy should prefer `Fix with agent` or `Address findings`, not wording that implies manual local editing in the primary flow.

## I) Studio lifecycle + recovery (normative)

Studio runtime model:

1. `nimbus review studio` starts or reuses a detached local Studio service.
2. Studio survives terminal exit after launch.
3. Studio runtime state lives under repo-local `.nimbus/studio/`.
4. `nimbus review open` is compatibility-only and must route into this same Studio lifecycle model during transition.

Runtime files:

- `.nimbus/studio.json`
  - repo-scoped user preferences only
- `.nimbus/studio/runtime.json`
  - active Studio runtime metadata for the repo
- `.nimbus/studio/worktrees/` or equivalent environment metadata directory
  - environment/runtime metadata records

Minimal runtime metadata example:

```json
{
  "version": 1,
  "repoRoot": "/abs/path/to/repo",
  "port": 2000,
  "pid": 48122,
  "startedAt": "2026-04-02T14:12:55.000Z",
  "lastHeartbeatAt": "2026-04-02T14:15:04.000Z",
  "activeReviewIds": ["rev_abc12345"],
  "activeRoute": "/reports/rev_abc12345",
  "replayCursors": {
    "rev_abc12345": 42
  }
}
```

Runtime metadata constraints:

1. This file is runtime state, not user preference state.
2. It may be replaced or repaired on startup if stale or invalid.
3. It must not contain secrets or raw API tokens.

Lifecycle rules:

1. Launch:
   - if no Studio service exists for the repo, start one detached and write runtime metadata
   - if a healthy Studio service already exists, reuse it
2. Browser open:
   - Studio may open a browser tab on launch
   - re-launch should prefer reusing the existing service and route rather than starting duplicates
3. Terminal independence:
   - closing the terminal must not kill Studio by default
4. Restart recovery:
   - after Studio restart, Home and Review Run routes must reconnect to active runs using persisted runtime metadata plus worker state
5. Health/lock handling:
   - stale runtime metadata must be detected and replaced safely
   - duplicate Studio daemons for the same repo should be avoided by lock or health-check semantics

Recovery rules:

1. If Studio dies while a worker-run review continues, the worker remains the source of truth and the review continues.
2. On Studio restart, the UI must be able to reconnect and catch up from persisted state plus worker replay.
3. If browser refresh happens during an active run, the route should reload current review state, then resume live updates.

## J) Event transport + replay rules (normative)

Stream identity:

1. Event ordering is monotonic by `seq` within a single `reviewId` stream.
2. `seq` is assigned by the worker event stream and is the canonical dedupe/replay cursor.
3. Clients dedupe by `(reviewId, seq)`.

Load and resume behavior:

1. Browser route load:
   - fetch current review snapshot first
   - then attach live stream using the latest known `seq`
2. Browser refresh:
   - reload snapshot
   - replay any missed events after last known `seq`
3. Studio restart:
   - reconnect to worker stream
   - request replay from last persisted `seq` per active review when available
4. Duplicate events:
   - ignored by dedupe rule
5. Gap handling:
   - if replay cursor is unavailable or a gap is detected, fall back to full snapshot refresh and continue streaming from the refreshed cursor

Transport path:

1. Worker -> Studio uses SSE as canonical transport.
2. Studio -> browser uses WebSocket as primary interactive transport.
3. Browser may fall back to SSE or polling when WebSocket is unavailable.

Resilience rules:

1. Studio must not invent synthetic terminal outcomes; terminal truth comes from worker state/events.
2. Curated event messages may summarize worker events but may not change their status meaning.
3. If Studio is offline while a review progresses, later replay must preserve event order for the same review.

## K) Finalized environment retention and config rules (normative)

Config placement:

1. `.nimbus/studio.json` lives at repo root and is repo-scoped.
2. `.nimbus/studio/` stores runtime and environment metadata for that repo.
3. Preference config is distinct from runtime metadata and must not contain secrets.

Environment metadata placement:

1. Environment metadata records live under `.nimbus/studio/worktrees/` or an equivalently named repo-local directory.
2. The directory may back either sandbox environments, local worktrees, or both, but the metadata contract is stable regardless of implementation.

Minimal environment metadata example:

```json
{
  "version": 1,
  "environmentId": "env_abc12345",
  "workspaceId": "ws_abc12345",
  "mode": "edit",
  "reviewBasis": "environment",
  "pinned": false,
  "exported": false,
  "hasUnexportedEdits": true,
  "createdAt": "2026-04-02T14:13:10.000Z",
  "lastTouchedAt": "2026-04-02T14:27:44.000Z",
  "parentReviewId": "rev_abc12345",
  "parentTaskId": "task_abc12345",
  "anchorCheckpointId": "chk_original",
  "anchorCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "branch": "feature/x",
  "status": "ready"
}
```

Environment metadata constraints:

1. `anchorCheckpointId` and `anchorCommitSha` identify immutable provenance.
2. `reviewBasis` distinguishes fresh checkpoint reviews from current-environment validation reviews.
3. `hasUnexportedEdits` gates cleanup and must be conservative.
4. The metadata contract must stay stable even if the underlying implementation is sandbox-only, local-worktree-backed, or hybrid.

Retention defaults:

1. `review` mode TTL: 24 hours since `lastTouchedAt`
2. `edit` mode TTL: 14 days since `lastTouchedAt`

Retention rules:

1. Sweep on Studio startup and every 6 hours.
2. Sweep `review` mode by default.
3. `edit` mode is only sweep-eligible after TTL and only if not pinned.
4. Never auto-delete:
   - active/locked environments
   - pinned environments
   - environments with unexported edits
   - `edit` environments before TTL expiry

Environment export/apply rules:

1. Local apply/export is always explicit.
2. Agent remediation does not implicitly sync changes back into the user working tree.
3. The environment remains the authoritative mutable state until the user exports/applies it.

## L) Worker API delta notes (implementation-facing)

These notes are not a full API reference. They exist to freeze the minimum request/response changes implementation should preserve across CLI, worker, and UI.

Review create request deltas:

```json
{
  "target": {
    "type": "workspace_deployment",
    "workspaceId": "ws_abc12345",
    "deploymentId": "dep_abc12345"
  },
  "mode": "report_only",
  "policyMode": "none|auto|review",
  "reviewBasis": "checkpoint|environment",
  "environment": {
    "environmentId": "env_abc12345"
  },
  "provenance": {
    "repo": "owner/repo",
    "branch": "feature/x",
    "commitSha": "<40-char sha>",
    "anchorCheckpointId": "chk_original",
    "anchorCommitSha": "<40-char sha>"
  }
}
```

Review create rules:

1. `policyMode` is canonical at the API boundary and must accept `none|auto|review`.
2. `reviewBasis = checkpoint` is the default for fresh review creation.
3. `reviewBasis = environment` requires environment identity sufficient for the worker to review current mutable environment state.
4. `environment` may be omitted for checkpoint-basis reviews.

Review query/stream response deltas:

```json
{
  "review": {
    "id": "rev_abc12345",
    "status": "running",
    "policyMode": "auto",
    "reviewBasis": "environment",
    "environment": {
      "environmentId": "env_abc12345",
      "mode": "edit"
    },
    "provenance": {
      "repo": "owner/repo",
      "branch": "feature/x",
      "anchorCheckpointId": "chk_original",
      "anchorCommitSha": "<40-char sha>"
    }
  }
}
```

Review query/stream rules:

1. Query responses must expose enough basis/provenance metadata for the UI to label whether the review is anchored to checkpoint state or current environment state.
2. Event payloads do not need to repeat every provenance field on every frame, but they must preserve `reviewId`, `seq`, and status truth.
3. If environment-level review support is partially unavailable, the worker must fail explicitly rather than silently downgrading to checkpoint review semantics.

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

1. UI affordance details for keep/archive/cleanup actions.
2. Optional future exposure of environment internals for power users.
