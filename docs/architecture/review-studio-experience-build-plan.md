# Review Studio Experience Build Plan (UX + Technical Guardrails)

Status: Ready for implementation handoff
Depends on: `docs/architecture/review-studio-experience.md`
Scope: User-facing flow sequencing plus implementation guardrails required to preserve approved architecture boundaries

## Objective

Ship a seamless review loop that feels continuous from launch to rerun:

1. Open Studio
2. Start review quickly
3. Observe progress with optional depth
4. Act on findings
5. Rerun after fixes

## Guardrails

1. Keep branch awareness explicit and stable.
2. Keep pre-review choices minimal.
3. Preserve one-route lifecycle for review runs.
4. Prioritize retry/recovery actions when failures happen.
5. Avoid adding advanced settings in this phase.

## Locked technical constraints (must honor)

1. Keep responsibility split:
   - local Studio resolves branch/checkpoint/Entire/co-change context
   - worker derives policy, owns review lifecycle, and persists run state/events
2. Event transport model:
   - worker -> Studio via SSE
   - Studio -> browser via WebSocket (fallback path allowed)
3. Policy mode preference persists per repo in `.nimbus/studio.json` (gitignored, schema-versioned).
4. New review start must be idempotent (disable CTA, request keying, worker dedupe).
5. OpenRouter key handling must follow request override > env fallback, with redaction and no persistence.
6. Review environments default to detached ephemeral worktrees with mode-based retention (`review` and `edit`).
7. Payload, event envelope, and retention defaults must match the implementation appendix in `review-studio-experience.md`.

## Phase 0: Technical foundation for seamless flow

### Goal

Install the runtime scaffolding required for the UX to behave consistently.

### Deliverables

1. Studio local control-plane endpoints exist for Home/New Review/Run state composition.
2. Branch detector is active with debounced change signaling.
3. Repo-local preference store exists (`.nimbus/studio.json`) with policy mode persistence.
4. Review start idempotency pipeline is wired (UI lock + idempotency key + worker dedupe).
5. Worktree manager exists with:
   - detached worktree creation per run
   - mode metadata (`review` | `edit`)
   - startup stale sweep for safe `review` environments only
   - explicit keep/archive/cleanup action hooks

### Acceptance checks

1. Starting a review twice quickly does not create duplicate runs.
2. Branch change signal appears consistently without auto-switch.
3. Policy mode preference survives Studio restart for same repo.
4. No secrets are written to config files or surfaced in logs/events.
5. Worktree metadata is created for every Studio-started review.

## Build sequence

## Implementation order by owner

Use this section to coordinate work across agents without breaking the approved UX boundary.

## Owner responsibilities

1. CLI/Studio owner
   - local control-plane endpoints for Home/New Review/Run composition
   - git branch detection and context-switch signaling
   - local Entire/checkpoint/co-change resolution and normalized payload assembly
   - repo-local preference persistence (`.nimbus/studio.json`)
   - worktree manager (`review`/`edit` modes, metadata, safe sweeps)

2. Worker owner
   - policy derivation/approval lifecycle endpoints and state transitions
   - review run persistence/events as source of truth
   - idempotent run-start handling and dedupe behavior
   - OpenRouter key precedence and redaction-safe handling

3. UI owner
   - Home control-center surface and branch-context rendering
   - New Review slide-over with policy mode and preflight card
   - single-route run lifecycle UI with `Agent Thinking` panel
   - completion/failure recovery actions and parallel run clarity

## Recommended execution order (cross-owner)

1. CLI/Studio + Worker: finish Phase 0 foundation contracts first.
2. Worker: validate idempotent start + policy lifecycle endpoints against Studio payload shape.
3. CLI/Studio: complete branch/context + preferences + worktree metadata flows.
4. UI: ship Phase A Home on top of live Studio branch-context endpoint.
5. UI + CLI/Studio: ship Phase B slide-over using real target/policy defaults.
6. UI + CLI/Studio + Worker: ship Phase C single-route run lifecycle + event bridge.
7. UI + CLI/Studio: ship Phase D completion/failure action flows.
8. CLI/Studio + UI: ship Phase E parallel clarity + mode promotion affordances.

## Handoff checkpoints between owners

1. Foundation contract checkpoint
   - Studio payload shape for worker policy/run start is frozen.
   - Event envelope contract for curated/raw thinking is frozen.

2. Home readiness checkpoint
   - Branch-context endpoint is stable.
   - Active/recent review query shape is stable.

3. Run lifecycle checkpoint
   - State machine labels and terminal statuses are frozen for UI mapping.
   - Recovery action intents and parameters are frozen.

4. Parallel/worktree checkpoint
   - Environment metadata schema is frozen (`review`/`edit`, pinned, timestamps, parent ids).
   - Cleanup safety rules are enforced before exposing bulk cleanup actions.

## Phase A: Home as control center

### Goal

Make Home actionable, not just historical.

### Deliverables

1. Home defaults to current-branch context.
2. Dominant `New Review` CTA is visible above fold.
3. Secondary `Resume active review` CTA appears when applicable.
4. Recent reviews section shows last 3 reviews for current branch.
5. Branch switch banner appears with explicit `Switch context` action.

### Acceptance checks

1. User can identify current branch context in under 2 seconds.
2. User can start new review in one click from Home.
3. User is never silently switched to a different branch context.

## Phase B: New Review slide-over

### Goal

Start reviews with near-zero friction.

### Deliverables

1. Slide-over opens from Home without route change.
2. Default target resolves latest checkpoint from current branch using existing fallback behavior.
3. If no checkpoint exists at all, show explicit hard-fail state.
4. Policy mode selection only:
   - `Auto policy`
   - `Review policy first`
5. Policy mode sticks per repository.
6. Preflight summary card shows branch, checkpoint, policy mode, and readiness.
7. Start path uses local-resolved Entire/checkpoint context and sends normalized payload to worker policy/lifecycle pipeline.
8. `Start Review` moves user straight into Review Run route.

### Acceptance checks

1. Happy path from Home to Running state requires no more than 2 user actions.
2. Policy mode is visible before start and persisted for next run in same repo.
3. Hard-fail empty-checkpoint state gives clear next step language.

## Phase C: Review Run single-route lifecycle

### Goal

Keep users on one continuous screen through queued/running/completed/failed.

### Deliverables

1. One route morphs across states:
   - Queued
   - Running
   - Completed
   - Failed
2. Default progress area is quiet summary (status, stage, elapsed).
3. `Agent Thinking` panel is expandable.
4. `Agent Thinking` supports:
    - curated summaries by default
    - raw stream toggle
5. Policy reference remains visible throughout run/result.
6. Event bridge streams worker events to UI without requiring terminal interaction.

### Acceptance checks

1. No forced navigation on completion.
2. User can understand run status at a glance without opening logs.
3. User can inspect deeper run detail without leaving page context.

## Phase D: Completion and failure actions

### Goal

Turn output into immediate next action.

### Deliverables

1. Completed state prioritizes:
   - `Act on findings`
   - `Run another review`
2. `Run another review` pre-fills same branch + latest checkpoint.
3. Failed state prioritizes recovery actions:
   - `Retry same inputs`
   - `Retry with policy review`
4. Diagnostics are present but visually secondary.

### Acceptance checks

1. User can launch follow-up review in one click after applying fixes.
2. Failure path offers immediate retry without forcing page reset.

## Phase E: Parallel review clarity

### Goal

Allow parallel runs without confusion.

### Deliverables

1. Parallel review starts are allowed.
2. Every run surface clearly shows branch + target context.
3. Home and recent activity do not collapse or hide active parallel runs.
4. Each parallel review uses isolated detached worktree environment metadata.
5. `review` mode environments can be promoted to `edit` mode for follow-up code changes.

### Acceptance checks

1. User can distinguish multiple active reviews quickly.
2. User can resume correct active review from Home.

## UX QA checklist (manual)

Run these scenarios before marking phase complete:

1. Happy path: Home -> New Review -> Running -> Completed -> Run another review.
2. Policy approval path: choose `Review policy first`, approve, run completes.
3. Skip path: choose `Auto policy`, run starts immediately.
4. Branch change while Home open: banner appears, no auto-switch occurs.
5. No-checkpoint branch: hard-fail experience appears with clear messaging.
6. Failure path: retry same inputs and retry with policy review both available.
7. Parallel path: start two runs and resume each from Home correctly.
8. Terminal optionality: after launch, full loop works from UI alone.
9. Worktree lifecycle: review run creates detached environment; keep/archive/cleanup controls behave safely.
10. Edit intent path: promoted `edit` environments are retained and not swept as stale `review` environments.
11. Security path: request-level OpenRouter key override works and no key material appears in persisted config/logs.

## Prioritized backlog after v1

1. Finding-level discussion panel (`Discuss finding`) for question/answer and fix refinement.
2. Optional exposure of isolated review environment concept (without leaking implementation jargon).
3. Advanced configuration section (deferred intentionally).
4. Stronger branch-level review comparison and trend views.

## Definition of done (UX)

This plan is complete when:

1. All Phase A-E acceptance checks pass.
2. UX QA scenarios pass without requiring terminal prompts mid-flow.
3. Experience matches the decisions in `review-studio-experience.md`.
4. No extra decision points were introduced beyond approved scope.
