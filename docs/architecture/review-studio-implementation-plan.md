# Review Studio Status and Delivery Plan

## Status

- State: living rollout status
- Last updated: 2026-04-12
- Current completion snapshot:
  - Slice 0 foundation: partial
  - Slice 1 Home: shipped
  - Slice 2 New Review slide-over: shipped
  - Slice 3 Review Run pre-run policy states: functionally shipped, not yet hardened
  - Slice 4 Review Run active states: partial
  - Slice 5 terminal actions and fix loop: not started
  - Slice 6 hardening: not started

## Purpose

This is the current source of truth for Review Studio rollout status.

This file tracks the current shipped state of the existing Review Studio implementation.

For the active product-direction pivot toward session-based review convergence, read `review-session-pivot.md` alongside this file.

Use this file to answer:

- what has shipped already
- what is only partially implemented
- what the next recommended slice is
- which older planning docs are historical context rather than current status

Use the other Review Studio docs as follows:

- `review-studio-experience.md`: locked product spec and north star
- `review-studio-experience-build-plan.md`: historical planning snapshot from before slices started landing

## Locked decisions still in force

These remain the active contract unless explicitly re-approved:

1. `nimbus review studio` is the canonical Studio launch command.
2. `nimbus review create` remains the canonical review-start command.
3. `--policy-mode none|auto|review` is canonical; `--auto-policy` and `--policy` are sugar.
4. `nimbus review open` is compatibility-only.
5. Bare CLI `review create` defaults to `policy-mode none`.
6. Studio uses saved repo preference when available; first-run Studio default is `policy-mode auto`.
7. Worker remains the source of truth for review state and event history.
8. The checkpoint/commit remains the immutable provenance anchor for fresh reviews.
9. Agent remediation and current-environment validation are still planned product directions, not completed product surfaces.

## What has shipped

## Slice 0: Foundation

State: partial

What is implemented:

- canonical CLI taxonomy for `review studio`, `review create`, policy mode parsing, and `review open` compatibility routing
- detached Studio runtime startup, reuse, stop, and status handling
- repo-local Studio preference/runtime metadata under `.nimbus/`
- worker contract support for canonical `policyMode` and `reviewBasis`
- local Studio endpoints for:
  - branch context
  - new-review preflight
  - new-review start
  - new-review start event streaming
- local review-event fanout with in-memory replay and dedupe scaffolding

Primary implementation files:

- `packages/cli/src/app/reviews/open.ts`
  - compatibility routing from `review open` to the canonical Studio flow
- `packages/cli/src/app/reviews/session.ts`
  - detached Studio runtime metadata and repo-local preference storage under `.nimbus/`
- `packages/cli/src/app/reviews/ui-proxy.ts`
  - local Studio HTTP endpoints for branch context, preflight, create, and event bridging
- `packages/cli/src/app/reviews/ui-events-fanout.ts`
  - in-memory replay, dedupe, and local fanout for review events
- `packages/worker/src/api/reviews/create.ts`
  - canonical review creation contract, including `policyMode` and `reviewBasis`
- `packages/worker/src/api/reviews/policy.ts`
  - policy-first review creation and approval lifecycle entrypoints

Concrete gap evidence:

- `packages/cli/src/app/reviews/session.ts`
  - runtime metadata initializes `replayCursors`, but they are not yet carrying durable replay state across Studio restarts
- `packages/cli/src/app/reviews/ui-events-fanout.ts`
  - replay state is held in memory and cleaned up on a short TTL, which is useful for local continuity but is not full restart persistence

What is still missing for this slice to be truly complete:

- replay cursor persistence that survives Studio restart in a durable way
- the broader worktree/edit-environment model assumed by the original planning docs
- stronger end-to-end proof that restart/recovery behavior is stable beyond the current in-memory fanout model

## Slice 1: Home

State: shipped

What shipped:

- Studio opens to Home
- current branch context is visible
- `New Review` is prominent
- `Resume active review` appears when applicable
- recent reviews render for the current branch
- branch change requires explicit user confirmation rather than auto-switching

Primary implementation files:

- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
  - Home surface, branch-aware CTA flow, and branch-switch confirmation banner
- `packages/cli/src/app/reviews/ui-proxy.ts`
  - branch-context and review-history data source for the Home page

Primary evidence in code/tests:

- branch-switch banner and explicit switch action in `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- Home render and resume scenarios in `packages/report-ui/src/components/ReviewHistoryPage.test.tsx`

## Slice 2: New Review slide-over

State: shipped

What shipped:

- New Review opens without route change
- default checkpoint resolution is driven from current branch context
- policy mode is selected in the Home flow and persisted per repo
- preflight returns branch, checkpoint, readiness, and checkpoint-count context
- start path creates the review and routes into the Review Run page
- start-progress streaming exists for the initial handoff

Primary implementation files:

- `packages/cli/src/app/reviews/studio-create.ts`
  - checkpoint resolution, preflight shaping, repo policy preference persistence, and create flow
- `packages/cli/src/app/reviews/ui-proxy.ts`
  - Studio preflight and create endpoints used by the UI
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
  - slide-over UI, policy-mode selection, and start-review interaction

Primary evidence in code/tests:

- preflight + start flow in `packages/cli/test/app/reviews/studio-create.test.ts`
- proxy endpoint coverage in `packages/cli/test/app/reviews/ui-proxy.test.ts`
- ReviewHistoryPage start-flow coverage in `packages/report-ui/src/components/ReviewHistoryPage.test.tsx`

Current caveat:

- this flow is still checkpoint-centric and does not yet expose the planned mutable-environment review loop

## Slice 3: Review Run, pre-run policy states

State: functionally shipped, not yet hardened

What shipped:

- `policy_pending`, `policy_ready`, and `policy_approved` are first-class states
- those states render on the same Review Run route rather than forcing route changes
- policy approval happens on the same route
- the old policy page is now effectively a legacy alias over the shared Review Run surface

Current progress:

- the user-visible policy flow now matches the intended route model
- policy-stage reviews no longer require a separate dedicated page to make forward progress
- approval transitions cleanly into queue handoff on the same route
- the behavior is covered well enough to treat the slice as landed from a product-flow perspective

Primary implementation files:

- `packages/report-ui/src/components/ReportPage.tsx`
  - unified Review Run route for policy states and later run states
- `packages/report-ui/src/components/PolicyPage.tsx`
  - compatibility wrapper onto the shared Review Run surface
- `packages/worker/src/api/reviews/policy.ts`
  - policy request, approval, and state transition API contract

Primary evidence in code/tests:

- policy-state rendering and approval coverage in `packages/report-ui/src/components/ReportPage.test.tsx`
- `PolicyPage.tsx` delegates to the shared route surface

Standing problems:

- refresh/restart behavior during the policy flow is acceptable today, but the stronger persisted replay/recovery guarantees from the original foundation plan are still not fully finished
- local replay state is still primarily transient CLI memory rather than durable per-review recovery state
- policy-stage behavior is implemented inside the still-large `ReportPage.tsx`, so the product flow is ahead of the UI structure/maintainability story
- the current implementation relies on shared polling/live-stream behavior rather than a more explicit, hardened policy-stage recovery model

Concrete gap evidence:

- `packages/cli/src/app/reviews/session.ts`
  - runtime metadata still initializes `replayCursors` as empty state rather than persisting a stronger recovery position
- `packages/cli/src/app/reviews/ui-events-fanout.ts`
  - replay buffering remains TTL-based in local memory
- `packages/report-ui/src/components/ReportPage.tsx`
  - policy timers, stream handling, recovery actions, and later run/terminal states still live in one large route component

## What is only partial

## Slice 4: Review Run, active states

State: partial

Already present:

- `queued` and `running` render on the Review Run route
- live activity/event streaming exists
- manual recover/fail actions exist for stalled queued/running reviews
- worker event sequencing and client-side dedupe scaffolding exist

Primary implementation files:

- `packages/report-ui/src/components/ReportPage.tsx`
  - queued/running UI, activity panel, and recovery controls
- `packages/cli/src/app/reviews/ui-events-fanout.ts`
  - local stream dedupe and replay buffer behavior
- `packages/worker/src/api/reviews/events-stream.ts`
  - backend event stream consumed by local Studio fanout

Missing versus target:

- the spec's first-class `Agent Thinking` experience is not yet truly productized
- replay and restart handling still rely too heavily on transient local state
- the active-state UI still reads more like a report activity panel than the finished Studio run surface
- the delivery doc should treat this as the next main slice rather than pretending the active run experience is done

Concrete gap evidence:

- `packages/report-ui/src/components/ReportPage.tsx`
  - one component still owns policy, active-run, failure, and findings surfaces, which makes the active-run experience feel like a mode inside the report page rather than a finished Studio run surface
- `packages/cli/src/app/reviews/ui-events-fanout.ts`
  - replay cleanup remains TTL-based local memory rather than durable recovery state

## What has not shipped yet

## Slice 5: terminal states and fix loop

State: not started

Not shipped yet:

- `Fix with agent` as a real product action
- `Review current environment` as a real validation-review path
- explicit mutable-environment lifecycle and safety rules
- the full terminal action model from the spec

Current reality:

- terminal review pages show findings, summaries, and failure guidance
- they do not yet implement the planned fix loop from the product spec

Primary current-state files:

- `packages/report-ui/src/components/ReportPage.tsx`
  - terminal review surface today
- `docs/architecture/review-studio-experience.md`
  - product spec for the not-yet-built fix loop

## Slice 6: hardening pass

State: not started

Not shipped yet:

- full end-to-end Studio hardening across launch, refresh, restart, retry, and fix-loop transitions
- the stronger cleanup and retention behavior expected once mutable environments exist
- the final "terminal optional" proof across the whole intended product loop

## Recommended next slice

Focus next on Slice 4: Review Run active states.

Why this is the right next move:

1. Slices 1-3 already make the front half of Studio coherent.
2. The largest remaining product gap before the fix loop is the quality and durability of queued/running states.
3. Finishing active-state polish reduces the chance of building the fix loop on top of weak replay/recovery behavior.
4. It avoids prematurely building edit-environment and worktree machinery before the main run surface is solid.

## Proposed definition of done for the next slice

1. Queued and running remain on one stable route with no navigation churn.
2. The active-state surface clearly distinguishes:
   - quiet progress summary
   - deeper review activity
   - retry/recovery controls
3. Replay and dedupe behavior are documented and reliable enough for browser refresh and Studio restart.
4. Local clients do not invent synthetic terminal outcomes.
5. The UI language matches the product spec more closely than the current generic live-activity presentation.

## Explicitly deferred until after Slice 4

Do not mix these into the active-state slice unless required by a discovered blocker:

- worktree-backed `review`/`edit` environment lifecycle
- `Fix with agent`
- `Review current environment`
- export/apply back to the local repo
- `Discuss finding`
- broader parallel-environment retention and cleanup rules

## Historical note

The older `review-studio-experience-build-plan.md` remains in the repo as planning context from before slices 1-3 landed.

It should not be used as the current rollout status document.

This file is now the current delivery/status view.
