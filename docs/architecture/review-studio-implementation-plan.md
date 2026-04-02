# Review Studio Implementation Plan

## Status

- State: implementation-ready plan
- Depends on:
  - `docs/architecture/review-studio-experience.md`
  - `docs/architecture/review-studio-experience-build-plan.md`

## Goal

Translate the locked Review Studio UX and lifecycle decisions into concrete repo work across CLI, local Studio runtime, worker APIs, and UI.

This plan is intentionally implementation-oriented:

- it names likely file targets in this repo
- it preserves the locked command taxonomy and state model
- it sequences work to keep the critical path moving
- it avoids introducing a parallel architecture next to the current CLI/report-ui stack

## Locked decisions this plan assumes

1. `nimbus review studio` is the canonical Studio launch command.
2. `nimbus review create` remains the canonical review-start command.
3. `--policy-mode none|auto|review` is canonical; `--auto-policy` and `--policy` are sugar.
4. `nimbus review open` becomes compatibility-only.
5. Bare CLI `review create` defaults to `policy-mode none`.
6. Studio uses saved repo preference when available; first-run Studio default is `policy-mode auto`.
7. The checkpoint/commit is the immutable provenance anchor.
8. Agent remediation happens in mutable environment state.
9. Follow-up validation reviews run against current environment state.
10. Export/apply back to the local repo is always explicit.

## Non-goals for this implementation pass

1. No framework migration for the report UI.
2. No attempt to complete the full Phase 9 conversational editing product in one pass.
3. No change to the current Cloudflare worker as source of truth for review state/events.
4. No requirement to expose “worktree” as product vocabulary.

## Delivery strategy

Use the existing split:

- `packages/cli` owns command surface and local Studio runtime
- `packages/worker` owns review state, event truth, policy lifecycle, and environment/review contracts
- `packages/report-ui` owns Studio browser UX on top of the existing app shell

Do not invent a new top-level package for Studio in this phase.

## Workstream 1: Canonical CLI surface

### Outcome

The CLI surface matches the Studio docs and stops teaching `review open` as the primary model.

### Primary file targets

- `packages/cli/src/cli/help.ts`
- `packages/cli/src/lib/args.ts`
- `packages/cli/src/cli/dispatch/review.ts`
- `packages/cli/src/commands/review/create.ts`
- `packages/cli/src/commands/review/open.ts`
- `packages/cli/src/app/reviews/create-from-commit.ts`
- `packages/cli/src/app/reviews/create-from-deployment.ts`
- `packages/cli/src/app/reviews/open.ts`

### Required changes

1. Add `review studio` dispatch path as the canonical Studio command.
2. Keep `review start` only if needed as a compatibility alias to Studio startup; otherwise deprecate it in help text.
3. Add `--policy-mode` parsing with allowed values `none|auto|review`.
4. Add sugar flags:
   - `--auto-policy`
   - `--policy`
   - `--open-studio`
5. Reject conflicting policy flags at CLI parse/dispatch time.
6. Make `review create` default to `policy-mode none` when no policy flag is present.
7. Convert `review open` into compatibility routing:
   - preferred target: `review studio`
   - alternative target when invoked with create intent: `review create --policy-mode review --open-studio`
8. Update help/examples so new users learn `review studio` and `review create`, not `review open`.

### Tests

- `packages/cli/test/lib/args.test.ts`
- `packages/cli/test/commands/review/review.test.ts`

Add coverage for:

- canonical policy mode parsing
- sugar flag normalization
- defaulting behavior
- compatibility handling for `review open`

## Workstream 2: Local Studio runtime and repo-local state

### Outcome

Studio becomes a reusable local service with explicit runtime metadata, instead of a terminal-bound process that dies with the session.

### Primary file targets

- `packages/cli/src/app/reviews/session.ts`
- `packages/cli/src/app/reviews/ui-server.ts`
- `packages/cli/src/app/reviews/ui-static-server.ts`
- `packages/cli/src/app/reviews/ui-dev-server.ts`
- `packages/cli/src/app/reviews/ui-static.ts`
- `packages/cli/src/app/reviews/open.ts`
- `packages/cli/src/app/reviews/ui-proxy.ts`
- `packages/cli/src/app/reviews/ui-events-fanout.ts`

### New local artifacts

- `.nimbus/studio.json`
- `.nimbus/studio/runtime.json`
- `.nimbus/studio/worktrees/` (or equivalent metadata directory)

### Required changes

1. Replace terminal-managed lifetime with detached Studio service lifetime.
2. Add Studio runtime metadata:
   - pid/process identity or equivalent
   - port
   - launch time
   - repo root
   - active review routing hints
3. Reuse an existing healthy Studio service instead of launching duplicates.
4. Detect stale runtime metadata and recover safely.
5. Keep Studio alive after terminal exit by default.
6. Support browser relaunch/reopen without creating a second service.
7. Separate repo preference storage from runtime metadata.
8. Persist replay cursor metadata for active reviews if needed by the local fanout layer.

### Tests

- `packages/cli/test/app/reviews/session.test.ts`
- `packages/cli/test/app/reviews/ui-static.test.ts`

Add coverage for:

- startup vs reuse behavior
- stale runtime replacement
- terminal-independent lifecycle
- runtime metadata read/write behavior

## Workstream 3: Worker review contract updates

### Outcome

The worker can distinguish fresh checkpoint reviews from current-environment validation reviews while preserving existing review lifecycle and event truth.

### Primary file targets

- `packages/worker/src/index.ts`
- `packages/worker/src/api/reviews.ts`
- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/reviews/request-shared.ts`
- `packages/worker/src/api/reviews/shared.ts`
- `packages/worker/src/api/reviews/policy.ts`
- `packages/worker/src/api/reviews/policy-shared.ts`
- `packages/worker/src/api/reviews/events-stream.ts`
- `packages/worker/src/lib/review-runner.ts`
- `packages/worker/src/lib/review-runner/shared.ts`
- `packages/worker/src/lib/db/reviews/create.ts`
- `packages/worker/src/lib/db/reviews/query.ts`
- `packages/worker/src/lib/db/reviews/shared.ts`
- `packages/worker/src/types.ts`

### Required changes

1. Accept canonical `policyMode` values `none|auto|review`.
2. Accept and validate `reviewBasis = checkpoint|environment`.
3. Preserve current policy states:
   - `policy_pending`
   - `policy_ready`
   - `policy_approved`
4. Ensure event/status serialization includes policy states everywhere Studio consumes them.
5. Support fresh rerun vs validation rerun semantics:
   - fresh rerun resolves latest checkpoint again
   - validation rerun reviews current environment state
6. Preserve idempotency guarantees while keeping retry and rerun as new review ids.
7. Return enough environment/provenance metadata for the UI to label basis and anchor correctly.

Use `docs/architecture/review-studio-experience.md` section `L) Worker API delta notes (implementation-facing)` as the minimum contract target for request/response shape.

### Tests

- `packages/worker/test/api/reviews.test.ts`
- `packages/worker/test/lib/db.review.test.ts`
- `packages/worker/test/lib/review-runner.test.ts`
- `packages/worker/test/lib/db.events.test.ts`

Add coverage for:

- new policy mode enum handling
- review basis validation
- event status coverage for policy states
- retry vs rerun id semantics

## Workstream 4: Studio event transport, replay, and proxying

### Outcome

Studio route state survives browser refresh and Studio restart without losing worker-truth ordering.

### Primary file targets

- `packages/cli/src/app/reviews/ui-events-fanout.ts`
- `packages/cli/src/app/reviews/ui-proxy.ts`
- `packages/cli/src/clients/worker/reviews.ts`
- `packages/report-ui/src/lib/review.ts`

### Required changes

1. Freeze `seq` as the canonical replay cursor per `reviewId`.
2. Teach the CLI-side SSE fanout to resume from the last known cursor when possible.
3. Dedupe events by `(reviewId, seq)`.
4. On browser load:
   - fetch current review snapshot first
   - then attach live stream
5. On browser refresh:
   - reload snapshot
   - resume/replay from last known `seq`
6. On Studio restart:
   - reconnect to worker
   - catch up from persisted cursor or full snapshot fallback
7. Do not synthesize terminal outcomes locally.

### Tests

- `packages/cli/test/app/reviews/ui-static.test.ts`
- `packages/report-ui/src/lib/review.test.ts`

Add coverage for:

- replay buffer behavior
- duplicate suppression
- snapshot + stream merge behavior
- cursor fallback to full refresh on gaps

## Workstream 5: Review Run UI state model

### Outcome

The React UI renders every locked review state on one route with the correct panels and actions.

### Primary file targets

- `packages/report-ui/src/App.tsx`
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- `packages/report-ui/src/components/BranchReviewsPage.tsx`
- `packages/report-ui/src/components/PolicyPage.tsx`
- `packages/report-ui/src/components/ReportPage.tsx`
- `packages/report-ui/src/lib/review.ts`
- `packages/report-ui/src/types.ts`

### Required changes

1. Align the UI with the full state map:
   - `policy_pending`
   - `policy_ready`
   - `policy_approved`
   - `queued`
   - `running`
   - `succeeded`
   - `failed`
   - `cancelled`
2. Keep everything on one Review Run route even as state changes.
3. Keep policy visible as reference through run and result states.
4. Expose recovery-first actions in failed states.
5. Distinguish fresh rerun from environment validation review.
6. Keep branch/target context visible on all run surfaces.
7. Reflect environment/anchor provenance without leaking too much implementation jargon.

### Tests

- `packages/report-ui/src/components/ReportPage.test.tsx`
- `packages/report-ui/src/components/ReviewHistoryPage.test.tsx`
- `packages/report-ui/src/lib/review.test.ts`

Add coverage for:

- policy states
- cancelled state
- route stability across transitions
- replay-driven status refresh

## Workstream 6: Agent remediation loop and environment validation

### Outcome

The completed review page can transition into a mutable agent-remediation environment and then validate that environment with a new review run.

### Primary file targets

- `packages/report-ui/src/components/ReportPage.tsx`
- `packages/cli/src/app/reviews/open.ts`
- `packages/cli/src/app/workspaces/create.ts`
- `packages/worker/src/api/workspace-tasks.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`
- `packages/worker/src/api/workspaces/query.ts`
- `packages/worker/src/api/workspaces/query-diff.ts`
- `packages/worker/src/types.ts`

### Required changes

1. Replace vague “Act on findings” behavior with `Fix with agent`.
2. Create or reuse an edit-mode mutable environment derived from the original review anchor.
3. Keep the checkpoint as immutable provenance anchor.
4. Add `Review current environment` as a separate action from `Run another review`.
5. Ensure validation review targets current environment state, not the original checkpoint snapshot.
6. Keep local apply/export explicit and separate from remediation.

### Scope note

This workstream does not require the full conversational editing product to land before Studio can ship. A narrower “run bounded agent task against current environment” slice is enough for the first implementation pass, as long as the provenance and validation-review model match the locked docs.

### Tests

- `packages/worker/test/api/workspace-tasks.test.ts`
- `packages/worker/test/lib/workspace-task-runner.test.ts`
- UI tests added near `ReportPage`

Add coverage for:

- mutable environment creation/reuse
- validation review basis
- no implicit local apply

## Workstream 7: Explicit export/apply path

### Outcome

Users can explicitly bring environment changes back locally without collapsing the distinction between mutable environment state and local repo state.

### Primary file targets

- `packages/cli/src/app/reviews/open.ts`
- `packages/cli/src/app/reviews/session.ts`
- `packages/worker/src/api/workspaces/operations-export.ts`
- `packages/worker/src/api/workspaces/artifacts.ts`
- `packages/worker/src/api/workspaces/github-branch.ts`
- `packages/worker/src/api/workspaces/github-push.ts`

### Required changes

1. Make export/apply an explicit user action.
2. Support at least one safe return path for v1:
   - local patch/apply
   - artifact export
   - GitHub branch push
3. Track exported/applied state in environment metadata so cleanup rules stay safe.

### Scope note

Choose one primary local-return path for the first pass and document the others as deferred if needed. Do not block Studio on perfect parity across every export surface.

## Critical path order

1. Workstream 1: canonical CLI surface
2. Workstream 3: worker review contract updates
3. Workstream 2: local Studio runtime
4. Workstream 4: event transport and replay
5. Workstream 5: Review Run UI state model
6. Workstream 6: agent remediation loop
7. Workstream 7: explicit export/apply path

Rationale:

- command and worker contracts must stabilize before UI behavior is reliable
- detached Studio lifecycle and replay are prerequisites for the “terminal optional” promise
- remediation and apply/export can layer on top once the run lifecycle is stable

## Suggested PR sequence

1. PR 1: CLI taxonomy and help updates
2. PR 2: worker policy mode + review basis contracts
3. PR 3: detached Studio runtime and metadata
4. PR 4: event replay/resume plumbing
5. PR 5: UI state-model alignment
6. PR 6: agent remediation and current-environment validation review
7. PR 7: explicit local export/apply path

## Verification matrix

### CLI

- `review studio` launches or reuses Studio
- `review create` defaults to `policy-mode none`
- `--policy-mode`, `--auto-policy`, `--policy`, and `--open-studio` behave consistently
- `review open` routes through compatibility behavior only

### Lifecycle

- Studio survives terminal exit
- browser refresh restores active run state
- Studio restart reconnects to in-flight runs
- event replay preserves ordering and avoids duplicates

### Review UX

- policy states render correctly on one route
- success/failure/cancelled states render correct actions
- `Run another review` starts a fresh checkpoint-based flow
- `Review current environment` validates mutable environment state

### Remediation/apply

- `Fix with agent` does not create a new review run
- mutable environment remains separate from local repo
- local apply/export is explicit
- cleanup does not remove environments with unexported edits

## Deferred follow-ons after initial Studio ship

1. Full conversational editing loop from `specs/phases/09-checkpoint-conversation-and-edit-loop.md`
2. Richer “Discuss finding” interactions
3. Stronger per-review diff comparison modes such as “since last review”
4. Power-user exposure of implementation details when useful

## Exit criteria

This implementation plan is complete when:

1. The locked Studio docs and build plan are reflected in code-level behavior.
2. The current `review open` ambiguity is removed from the primary user-facing flow.
3. Studio can launch, survive terminal exit, resume runs, and render all review states on one route.
4. The fix loop works as:
   - review checkpoint-derived environment
   - fix with agent in mutable environment
   - review current environment
   - export/apply locally by explicit action

## Delivery plan (experience-first)

Use this section to ship Review Studio as vertical slices that correspond to actual user-visible surfaces.

This is the recommended delivery model:

1. ship one foundation slice first
2. then ship page-by-page vertical slices
3. then run one hardening pass across the full loop

This keeps engineering work aligned with the actual product experience rather than marking technical subsystems complete while the UI loop is still broken.

### Slice 0: Foundation

#### Scope

- canonical CLI taxonomy
- detached Studio runtime startup/reuse
- worker contract support for `policyMode` and `reviewBasis`
- replay/resume scaffolding

#### Entry criteria

- locked Studio docs are accepted
- command taxonomy is frozen
- policy/default semantics are frozen

#### Definition of done

1. `nimbus review studio` launches or reuses Studio.
2. `nimbus review create --policy-mode none|auto|review` works.
3. `nimbus review open` is compatibility-only.
4. Studio runtime metadata exists and can be reused after relaunch.
5. Worker accepts canonical `policyMode` and `reviewBasis`.
6. Browser refresh and Studio restart can reconnect to active reviews from worker truth plus replay.

#### Exit artifact

- Studio can boot reliably enough for page work to proceed without reworking process lifecycle later.

### Slice 1: Home

#### Scope

- current branch context
- `New Review`
- `Resume active review`
- recent reviews
- branch switch banner

#### Definition of done

1. Opening Studio lands on Home.
2. Current branch context is visible and accurate.
3. `New Review` is prominent and reachable in one click.
4. `Resume active review` appears only when applicable and routes correctly.
5. Recent reviews render for the current branch.
6. Branch change banner appears without silently switching context.
7. Empty states are clear and actionable.

#### Tests / checks

- UI test for Home render states
- manual branch-switch scenario
- resume-active-review scenario

### Slice 2: New Review slide-over

#### Scope

- checkpoint resolution
- policy mode picker
- preflight summary
- review-start CTA

#### Definition of done

1. New Review opens without route change.
2. Default target resolves latest checkpoint from current branch using the locked fallback behavior.
3. Studio defaults policy mode from repo preference, falling back to `auto` on first run.
4. Policy mode selection is persisted to `.nimbus/studio.json`.
5. Preflight summary shows branch, checkpoint, policy mode, and readiness.
6. Hard-fail no-checkpoint state is explicit and understandable.
7. `Start Review` creates the correct review flow and routes into the Review Run page.

#### Tests / checks

- CLI/Studio preference persistence coverage
- no-checkpoint UX check
- review-start path for all three policy modes

### Slice 3: Review Run, pre-run policy states

#### Scope

- `policy_pending`
- `policy_ready`
- `policy_approved`

#### Definition of done

1. Policy states are rendered as distinct user-visible route states.
2. `policy_pending` shows progress without forcing a route change.
3. `policy_ready` allows user review/edit/approval on the same route.
4. `policy_approved` transitions cleanly into queue/execution state on the same route.
5. Refresh/restart preserves policy-stage route recovery.
6. Cancellation or abandonment behavior is explicit and does not create hidden duplicate runs.

#### Tests / checks

- worker policy-state API coverage
- UI state mapping coverage for all policy states
- refresh/restart recovery during policy flow

### Slice 4: Review Run, active states

#### Scope

- `queued`
- `running`
- quiet progress
- `Agent Thinking`
- live event updates

#### Definition of done

1. The route stays stable while the review moves through `queued` and `running`.
2. Quiet progress is understandable at a glance.
3. `Agent Thinking` supports curated summaries and raw stream toggle.
4. Event replay/dedupe preserves ordering by `reviewId + seq`.
5. Browser refresh restores current state and continues live updates.
6. Studio restart reconnects and catches up correctly.
7. No synthetic terminal states are invented locally.

#### Tests / checks

- replay/dedupe coverage
- UI state merge coverage for snapshot + stream
- restart/refresh manual scenario

### Slice 5: Review Run, terminal states and fix loop

#### Scope

- `succeeded`
- `failed`
- `cancelled`
- `Fix with agent`
- `Review current environment`
- `Run another review`
- explicit export/apply

#### Definition of done

1. Success, failure, and cancelled states render distinctly.
2. Failure state prioritizes `Retry same inputs` and `Retry with policy review`.
3. `Run another review` starts a fresh checkpoint-based review flow.
4. `Fix with agent` creates or reuses mutable environment state without creating a new review run.
5. `Review current environment` creates a new validation review against current environment state.
6. Validation review does not silently downgrade to the original checkpoint snapshot.
7. Export/apply back to the local repo is explicit only.
8. Cleanup rules do not delete mutable environments with unexported edits.

#### Tests / checks

- terminal-state UI coverage
- remediation-loop coverage
- validation-review basis coverage
- explicit export/apply safety checks

### Slice 6: Hardening pass

#### Scope

- end-to-end polish
- recovery reliability
- cleanup safety
- compatibility cleanup

#### Definition of done

1. All page slices work together without terminal prompts mid-loop.
2. Full flow works:
   - Home
   - New Review
   - Policy or direct run
   - Active review
   - Terminal review
   - Fix with agent
   - Review current environment
   - Export/apply explicitly
3. Studio survives terminal exit, browser refresh, and local service restart.
4. Compatibility commands still work but are no longer the primary documented path.
5. QA checklist from the Studio build plan passes end-to-end.

## Experience-based release gate

Do not mark Review Studio “implemented” just because the APIs and command handlers exist.

Mark it implemented only when:

1. Slice 0 through Slice 6 are complete.
2. Each slice satisfies its own definition of done.
3. The end-to-end user loop works page-by-page without needing undocumented operator intervention.
