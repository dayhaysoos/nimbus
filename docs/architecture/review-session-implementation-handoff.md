# Review Session Implementation Handoff

## Status

- State: implementation handoff for the next session, with backend/CLI work largely complete
- Last updated: 2026-04-15
- Audience: humans or LLMs continuing Nimbus from the new session-based review model into the next UI pass
- Branch at time of writing: `review-session-redesign`
- Current `HEAD`: `a1a22fe4b0a934639a6166582f89bfa2ef3693f3`
- Compatibility stance: destructive cleanup remains acceptable; preserving older report-first semantics is not a priority

## What this document is for

This file captures what was actually implemented during the review-session redesign work, what was proven live, where the CLI experience is solid versus awkward, and what a fresh session needs to know before starting UI work.

This is not a speculative plan doc.
It is a handoff based on real changes, real tests, and real live-product runs.

Read this after:

1. `docs/architecture/architecture.md`
2. `docs/architecture/review-session-pivot.md`

Use this file when you need the current implementation state rather than the original product direction.

## Outcome summary

Nimbus now supports the core session-based review loop the product pivot was aiming for.

The implemented flow is:

1. User runs a review on a commit.
2. Nimbus creates or reuses the review base and starts a `ReviewSession`.
3. Nimbus runs the first review pass.
4. If findings are safe and worthwhile to address, Nimbus can remediate in the cloud workspace.
5. Nimbus can rerun follow-up environment reviews within the same session.
6. Nimbus stops with an explicit outcome instead of forcing the user to manually relay review/fix cycles.
7. If Nimbus changed code in the cloud workspace and the session is ready, the user can explicitly adopt those changes locally.
8. After adoption, the user can inspect diffs, enter the worktree, and merge the adopted changes back into the checked-out branch.

That is now real.
It is no longer just architecture intent.

## What was implemented

## Slice 1: reusable review bases

Implemented:

- checkpoint review creation reuses identical review bases instead of recreating workspaces/deployments every time
- identical checkpoint review requests can reuse prior workspace/deployment artifacts when compatible

Why it mattered:

- removed repeated setup cost from re-review loops
- made the session model practical because repeated passes no longer pay full environment setup every time

Primary areas changed:

- `packages/cli/src/app/reviews/context.ts`
- `packages/cli/src/app/reviews/create-shared.ts`
- `packages/worker/src/api/workspaces/create.ts`
- `packages/worker/src/api/workspace-deployments/create.ts`
- `packages/cli/src/app/workspaces/deploy.ts`

## Slice 2: ReviewSession as the main object

Implemented:

- durable `ReviewSession` records in the worker
- review creation links passes into a session
- session API and CLI visibility
- session outcome becomes a first-class thing rather than an implied property of a single review pass

Why it mattered:

- `review` could stop being a one-pass report shape
- session became the right unit for later UI work

Primary areas changed:

- `packages/worker/migrations/0016_review_sessions.sql`
- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/review-sessions.ts`
- `packages/cli/src/commands/review/show.ts`
- `packages/cli/src/commands/review/session.ts`

## Slice 3: session reruns against the mutable environment

Implemented:

- rerunning review in the same session against the environment basis
- session reset to baseline
- pass provenance distinguishes `checkpoint` vs `environment`
- environment revision tracking across passes

Why it mattered:

- enabled real follow-up passes over the edited cloud workspace instead of only fresh checkpoint reviews

Primary areas changed:

- `packages/worker/src/lib/review-session-pass.ts`
- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/cli/src/commands/review/session.ts`
- `packages/cli/src/clients/worker/workspaces.ts`

## Slice 4: bounded remediation loop

Implemented:

- safe-fix remediation inside the session workspace
- bounded continuation using session state plus review follow-up signals
- auto-remediation/follow-up chaining through environment reviews
- correct non-terminal session phases while remediation is still active
- stuck-remediation handling was fixed enough to stop lying about terminal state and to finish/fail cleanly

Important stop/continuation behavior:

- the boolean `furtherPassesLowYield` was explicitly demoted conceptually
- the real continuation signal is `followUpReviewScore`
- the product stance settled on:
  - `3` means another pass is likely worthwhile
  - `2` means maybe worthwhile depending on remaining fixable issues or recent progress
  - `1` means likely diminishing returns unless the user wants more control

Why it mattered:

- this is the slice that actually removed the manual user relay loop

Primary areas changed:

- `packages/worker/src/lib/review-runner/session-remediation.ts`
- `packages/worker/src/lib/review-runner/session-remediation-followup.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`
- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/worker/test/lib/review-session-remediation.test.ts`

## Pivot: non-Entire reviews

Implemented after the core session slices:

- reviews no longer hard-require `Entire-Checkpoint`
- non-Entire commits fall back to `basic` mode rather than failing
- `basic` mode reviews:
  - diff
  - changed files
  - repo conventions
  - no Entire-derived intent context
- sessions preserve context mode across follow-up passes

Why it mattered:

- Nimbus is no longer limited to Entire users
- Entire became the higher-confidence, intent-aware mode rather than the only supported mode

Important product distinction:

- `intent-aware` review: Entire/session context available
- `basic` review: code-aware only, no intent context

Primary areas changed:

- `packages/cli/src/app/reviews/context.ts`
- `packages/cli/src/commands/review/preflight.ts`
- `packages/worker/src/api/reviews/request-shared.ts`
- `packages/worker/src/lib/review-runner/context.ts`
- `packages/worker/src/lib/review-analysis/prompt.ts`
- `packages/worker/src/lib/review-runner/deployment-report/*`

## Slice 5: local-first return path

Implemented:

- internal concept remains `materialize`
- user-facing concept is `adopt`
- cloud-side changes can be brought local as:
  - isolated worktree
  - branch-only
- local adoption keeps the current checkout untouched by default

Why it mattered:

- it made the session flow useful locally without requiring PR-first delivery

Important product decision:

- do not auto-apply into the current working tree
- human-in-the-loop happens at adoption time
- a local branch/worktree is the handoff artifact, not a silent mutation of the current checkout

Primary areas changed:

- `packages/cli/src/app/reviews/materialize.ts`
- `packages/cli/src/app/reviews/adoption.ts`
- `packages/cli/src/commands/review/session.ts`
- `packages/cli/src/cli/dispatch/review.ts`
- `packages/cli/src/cli/help.ts`
- `packages/worker/src/api/workspaces/artifacts.ts`

## Slice 6: final outcome model

Implemented:

- final session outcome object with:
  - outcome kind
  - summary
  - residual risk
  - recommendation
  - context mode
  - evidence summary
  - unresolved findings summary
  - change summary
  - adopt readiness
- CLI renders outcome consistently on:
  - review create flows
  - review show
  - review session show

Why it mattered:

- it made the end of the session understandable without reading every pass manually
- it also defined the data contract the UI should now center around

Primary areas changed:

- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/worker/src/types.ts`
- `packages/cli/src/app/reviews/session-outcome.ts`
- `packages/cli/src/app/reviews/create-from-commit.ts`
- `packages/cli/src/app/reviews/create-from-session.ts`
- `packages/cli/src/commands/review/show.ts`
- `packages/cli/src/commands/review/session.ts`

## Local environment helpers

Implemented after adoption work because the raw worktree UX felt too awkward.

User-facing helpers now exist for local adopted sessions:

- `review session list-local`
- `review session diff-local [session-id]`
- `review session path-local [session-id]`
- `review session enter-local [session-id]`
- `review session merge-back [session-id]`

Why they exist:

- `cd` into a path under `~/.nimbus/studio/worktrees/...` is not a good primary UX
- the CLI needed helper commands around adopted sessions, not just a bare worktree path

Important behavior:

- `enter-local` cannot change the parent shell cwd directly
- it prints a shell-safe command the user can `eval`
- `merge-back` cherry-picks the adopted session commit onto the current branch rather than doing a raw merge of the session branch

Primary areas changed:

- `packages/cli/src/app/reviews/local-environments.ts`
- `packages/cli/src/commands/review/session.ts`
- `packages/cli/src/cli/dispatch/review.ts`
- `packages/cli/src/cli/help.ts`

## Remote session discovery

Implemented because session IDs were too hard to retrieve without remembering them manually.

Commands added:

- `review session list`
- `review session latest`
- existing `review session show <id>` remained the detailed view

Why it mattered:

- `ReviewSession` is now the primary object; the CLI needs discovery commands for it

Primary areas changed:

- `packages/worker/src/api/review-sessions.ts`
- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/cli/src/clients/worker/reviews.ts`
- `packages/cli/src/commands/review/session.ts`

## Merge-back validation and polish

Implemented and validated after adoption existed.

Behavior:

- `review session merge-back <session-id>` cherry-picks the adopted local session commit onto the current checked-out branch
- it refuses to run if:
  - current working tree is dirty
  - current checkout is detached
  - current checkout is already the adopted branch
  - adopted branch no longer exists
  - adopted commit is missing
- it is idempotent enough to treat already-applied sessions as a no-op

Important follow-up fixes surfaced by live validation:

- one adopted session commit introduced a TypeScript type issue in `create-shared.ts`
- `diff-local` originally used merge-base diffing and therefore gave the wrong mental model after a cherry-pick-based merge-back
- both were fixed in `a1a22fe`

## User-facing CLI surface

Current important commands:

### Review creation and inspection

```bash
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review create --commit HEAD
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review show <review-id>
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session show <session-id>
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session list --limit 5
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session latest
```

### Local adoption and inspection

```bash
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session adopt <session-id>
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session adopt <session-id> --branch-only
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session list-local
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session diff-local <session-id>
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session path-local <session-id>
eval "$(pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session enter-local <session-id>)"
```

### Merge-back

```bash
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review session merge-back <session-id>
```

## What was proven live

The following were not just tested locally; they were exercised against the real worker/CLI environment over the course of this branch.

### Proven live

- checkpoint review on real commits
- session creation and inspection
- environment follow-up passes inside the same session
- bounded auto-remediation for safe fixes
- non-Entire basic-mode reviews
- explicit adoption into a local worktree or branch
- local session listing and diffing
- merge-back into the current checked-out branch

### Important live examples from this branch

Examples that came up during live validation:

- `session_y4oxx1bk`
  - real adopted Nimbus session for this repo
  - local branch: `nimbus/session/session_y4oxx1bk`
  - used to validate real `merge-back`
- `04fc557ca06127b9a89f8dbb461e573459538b5a`
  - real cherry-picked merge-back commit created by `review session merge-back session_y4oxx1bk`
- `a1a22fe4b0a934639a6166582f89bfa2ef3693f3`
  - follow-up fix commit after merge-back surfaced two issues

These IDs are historical proof points, not product-facing fixtures.

## What is still rough

## 1. Worktree UX is still awkward without CLI helpers

This is partly solved now by the helper commands.

Still true:

- raw `cd ~/.nimbus/studio/worktrees/...` is not a satisfying primary experience
- a future UI should not force users to reason about filesystem paths directly

## 2. The UI is behind the product model

The backend and CLI are now session-centered.
The UI is still too report-centered.

This is the biggest remaining product gap.

What the UI should now treat as primary:

- `ReviewSession`, not `Review`
- pass timeline
- current phase
- stop reason
- outcome summary
- whether Nimbus changed code
- adoption affordances
- local environment status if adopted

## 3. Entire git hooks can hang locally

This came up during commit/push, not during review logic.

Observed behavior:

- local Entire `post-commit` hook could hang after the commit itself had already succeeded
- workaround used during this branch: push with `--no-verify` once the commit was confirmed

Product implication:

- Nimbus itself is not blocked because non-Entire reviews now work
- but local Entire operational flakiness still exists outside Nimbus

## 4. Deployed worker version may lag some source fixes

During this branch, CLI adoption was hardened to survive even if the worker-side review-context route was stale or unavailable.

Important implementation detail:

- CLI adoption can fall back to stored review context in R2 using local Wrangler auth when workspace patch export fails or worker context retrieval is unavailable

This makes the local adoption flow more robust than depending on one worker route alone.

## What the next UI session should do

The next agent should not rethink the backend model first.
It should assume the session-based review model is the primary product shape and build the UI around it.

Recommended UI focus:

## 1. Make `ReviewSession` the primary page object

A session page should show:

- phase
- latest review/pass
- pass timeline
- stop reason
- outcome summary
- unresolved findings summary
- whether Nimbus made changes
- whether adopt is ready

## 2. Make reports child artifacts of the session

A review pass/report still matters, but it should be subordinate to the session.

The session page should be able to drill into pass-level reports rather than using the report page as the main object.

## 3. Add adoption UX

UI should expose session actions corresponding to the CLI commands:

- adopt as worktree
- adopt as branch
- list local adopted environments for this repo
- show diff against current branch
- show path / enter command
- merge-back

Even if the UI cannot itself change the parent shell cwd, it can still expose the exact command and path cleanly.

## 4. Surface active-session truth clearly

The UI must not print a terminal-looking summary while a follow-up pass is still queued or running.

This was a major source of confusion during CLI validation and was fixed repeatedly in backend/CLI state handling.

The UI should only render terminal outcome UI when the session is truly terminal.

## 5. Use the current outcome model directly

Do not invent a second confidence model in the UI.
Use the existing session outcome fields and make them legible.

The current outcome contract is already good enough to drive the first serious UI pass.

## Suggested first UI screens / panels

Recommended session-first UI structure:

1. Session header
   - status, phase, pass count, context mode, latest recommendation
2. Outcome summary
   - summary, residual risk, unresolved count, evidence summary
3. Pass timeline
   - checkpoint pass, remediation, environment pass, timestamps
4. Findings and remaining issues
   - unresolved highlights and pass-level findings
5. Adoption panel
   - adopt ready / not ready
   - worktree vs branch actions
   - local session helpers
6. Merge-back panel
   - if adopted locally, show merge-back option and current status

## Important implementation decisions the next agent should preserve

- `adopt` is the user-facing verb; `materialize` is internal wording only
- non-Entire fallback is a first-class path, not a temporary degraded failure mode
- the human stays in the loop at adoption / merge-back time, not at every review pass
- direct mutation of the current checkout remains the wrong default
- merge-back is implemented as cherry-pick of the adopted commit, not raw branch merge
- CLI/local helpers are session-centered, not raw-git-concept-centered

## File map for the next session

If the next session is UI-heavy, these are the most important backend/CLI files to understand first.

### Worker

- `packages/worker/src/lib/db/review-sessions.ts`
- `packages/worker/src/api/review-sessions.ts`
- `packages/worker/src/types.ts`
- `packages/worker/src/lib/review-runner/session-remediation.ts`
- `packages/worker/src/lib/review-runner/session-remediation-followup.ts`

### CLI/session flow

- `packages/cli/src/app/reviews/create-shared.ts`
- `packages/cli/src/app/reviews/session-outcome.ts`
- `packages/cli/src/app/reviews/adoption.ts`
- `packages/cli/src/app/reviews/materialize.ts`
- `packages/cli/src/app/reviews/local-environments.ts`
- `packages/cli/src/commands/review/session.ts`
- `packages/cli/src/cli/dispatch/review.ts`

### Tests that already cover key local-session behavior

- `packages/cli/test/commands/review/review.test.ts`
- `packages/cli/test/lib/args.test.ts`
- `packages/worker/test/lib/review-session-remediation.test.ts`
- `packages/worker/test/lib/db.review.test.ts`

### UI starting points

- `packages/report-ui/src/App.tsx`
- `packages/report-ui/src/components/ReportPage.tsx`
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- `packages/report-ui/src/lib/review.ts`

## Recommended handoff prompt for the next session

If you want to start a fresh session for the UI work, the shortest good handoff is:

1. Read `docs/architecture/architecture.md`
2. Read `docs/architecture/review-session-pivot.md`
3. Read `docs/architecture/review-session-implementation-handoff.md`
4. Treat `ReviewSession` as the primary product object
5. Continue with the session-first UI reshape rather than reworking backend orchestration

## Bottom line

Nimbus now has the core product loop we were trying to build:

- session-based review
- bounded follow-up passes
- auto-remediation when safe
- explicit final outcome
- explicit user-controlled adoption
- local diff/inspect helpers
- merge-back into the checked-out branch

The biggest thing left is not backend invention.
It is making the UI feel like the product that the backend and CLI now already are.
