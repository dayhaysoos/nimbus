# Nimbus Review Session Pivot

## Status

- State: active product-direction and implementation handoff
- Last updated: 2026-04-12
- Audience: future sessions that need the full context for the review-loop redesign
- Compatibility stance: destructive simplification is allowed; legacy compatibility is not a priority

## Why this file exists

Nimbus currently supports a useful but frustrating loop:

1. Agent writes code.
2. User runs review.
3. Nimbus finds bugs or risks.
4. User relays findings back to the agent.
5. Agent applies fixes.
6. User runs review again on the new uncommitted state.
7. Repeat until review becomes quiet enough.

That loop is too manual, too repetitive, and too weak as a confidence model.

The user is acting as:

- scheduler
- message bus
- retry coordinator
- confidence interpreter

That is the waste we are trying to remove.

This document captures the product pivot and the implementation direction needed to make Nimbus feel like one smooth code review session instead of a pile of disconnected review passes.

## Product goal

Nimbus should stay focused on code review, but the review experience should become session-based rather than pass-based.

The target product loop is:

1. User asks Nimbus to review a change.
2. Nimbus gathers context, reviews the change, and classifies what it found.
3. Nimbus fixes what it can safely fix inside the same bounded session.
4. Nimbus re-verifies and re-reviews the updated environment.
5. Nimbus repeats internally for a limited number of cycles.
6. Nimbus returns one final outcome with evidence, remaining blockers, and residual risk.

The user should only need to intervene when:

- a product decision is needed
- a fix is too risky to apply automatically
- the user wants to inspect or steer the session manually

For this document, a `product decision` means:

- more than one plausible fix or behavior exists
- correctness depends on user intent that Nimbus cannot infer reliably from the code, tests, or existing repo conventions
- the choice changes user-visible behavior, public contract behavior, or an important system invariant

Examples of product decisions:

- choosing between two valid user-visible behaviors for an ambiguous edge case
- deciding whether to preserve or intentionally break existing external behavior
- deciding whether a new API, schema change, or workflow behavior is acceptable

Non-examples:

- straightforward bug fixes where the intended behavior is already clear
- normal implementation refactors
- style or readability cleanup
- low-risk internal fixes whose correctness can be verified directly

## Honest assessment of the current product

### What is good already

Nimbus already has most of the infrastructure primitives needed for this direction:

- durable persisted state in D1
- source and artifact storage in R2
- mutable execution environments via `@cloudflare/sandbox`
- queue-backed async work dispatch
- a review execution Durable Object (`ReviewRunner`)
- workspace task APIs that can read files, write files, run commands, and diff the current environment
- a review API contract that already acknowledges `reviewBasis = checkpoint | environment`

This means the redesign is not blocked on new platform capabilities.

### What is wrong with the current shape

The current product loop is wrong in a few important ways:

1. `review` behaves like a one-shot report instead of a bounded session.
2. commit/checkpoint review setup creates fresh workspaces too eagerly, which wastes setup cost.
3. the mutable-environment path exists only partially in the backend and is not the main user flow.
4. Review Studio still reads more like a report viewer with extra states than like a single coherent review session.
5. the user is still responsible for relaying findings back to the agent and deciding when to rerun.
6. a quiet review result is too weak to count as confidence.

## What problem we are actually solving

The problem is not just "make review faster".

The real problem is:

- one user-initiated review request should be able to converge a change as far as it safely can without forcing the user to manually shuttle findings and reruns between tools

That means Nimbus needs to become good at:

- reuse
- bounded iteration
- evidence collection
- explicit stopping conditions
- clear escalation when it cannot safely continue

## Current architecture primitives and how they should be understood

## Cloudflare pieces already in use

### D1

Current role:

- source of truth for workspaces, deployments, reviews, tasks, events, idempotency, and runtime flags

Keep it for:

- durable product state
- session records
- pass records
- lifecycle events
- recovery truth

Do not replace it with Durable Object storage for anything critical.

### R2

Current role:

- source bundles
- workspace artifacts
- review context blobs

Keep it for:

- immutable source snapshots
- exported artifacts
- large derived context payloads
- evidence blobs that should not live inline in D1

### Queues

Current role:

- checkpoint jobs
- workspace tasks
- workspace deployments
- reviews

Keep them for:

- async pass execution
- long-running remediation or verification work
- retryable background work

### `@cloudflare/sandbox`

Current role:

- mutable execution/runtime environment backing workspaces

This is the actual editable environment.

It is the right primitive for:

- applying code fixes
- running commands
- computing diffs against baseline
- holding current session state between passes

### Durable Objects

Current role:

- sandbox access namespace
- `ReviewRunner` for serialized review execution handoff

DOs are good here for:

- serialization
- coordination
- event fanout
- short-lived live session state
- cancellation/recovery orchestration

DOs are not a substitute for the sandbox itself.

The right mental model is:

- sandbox = mutable code environment
- DO = coordinator for live work against that environment

## Current Nimbus primitives

### Workspace

Current meaning:

- durable record tying together source snapshot, sandbox id, lifecycle state, and baseline/reset semantics

A workspace is not just "a sandbox".

More accurate model:

- workspace = durable environment identity + source bundle + sandbox handle + lifecycle metadata

This is useful and should stay.

### Workspace deployment

Current meaning:

- validation/provider execution record for a workspace

Open question:

- should deployments remain a first-class concept in the user-facing review model, or should they become an internal verification artifact?

Recommendation:

- do not force a decision immediately
- keep deployments internally for now where they help with verification and provenance
- avoid leaking deployment vocabulary into the user-facing review session product unless it proves necessary

### Review run

Current meaning:

- one persistent review lifecycle record tied to a workspace deployment

This is still useful, but it should stop being the top-level user object.

The top-level user object should become a review session.

### Workspace task

Current meaning:

- agentic task against a mutable workspace

This is already very close to the remediation primitive Nimbus needs.

It is the right substrate for:

- safe auto-fix attempts
- targeted code edits
- bounded verification actions inside the current environment

### `ReviewRunner`

Current meaning:

- serialized review execution coordinator

This should remain a coordinator.

It should not become the code environment.

## What to keep versus what to change

## Keep

These are strong primitives and should remain part of the system:

- workspaces
- sandbox-backed mutable environments
- D1 as the durable source of truth
- R2 for source/artifact/context storage
- review events as public contract for observability
- workspace tasks as the mutation primitive
- review runner orchestration
- queue-backed async processing

## Change

These parts are useful but need to be re-centered:

- commit/checkpoint review flow should reuse equivalent environments instead of always creating fresh ones
- review should stop being treated as the top-level user interaction object
- Review Studio should become a session UI, not a report-first UI with live states attached
- `reviewBasis=environment` should become a first-class product path rather than a backend-only affordance

## Remove or aggressively de-prioritize

Because there are zero external users, Nimbus should be willing to simplify destructively.

The following are acceptable candidates for removal or demotion:

- `nimbus review open` compatibility-first behavior
- report-first mental model as the main documented experience
- preserving old route or page boundaries purely for compatibility
- support for legacy flow assumptions where one review request always means one static review pass

## Recommended product model

## Top-level user object: `ReviewSession`

A `ReviewSession` should become the primary product object.

A review session represents one bounded attempt to evaluate and, where appropriate, improve a change.

It should own:

- target repo and branch
- target base commit or checkpoint anchor
- active workspace id
- current environment version or revision marker
- session phase
- pass count
- iteration budget
- stop reason
- final outcome summary

Possible phases:

- `preparing`
- `reviewing`
- `fixing`
- `verifying`
- `waiting_on_human`
- `completed`
- `failed`
- `cancelled`

`waiting_on_human` should be used only for:

- product decision required
- risky fix requiring approval
- explicit user-requested manual control

## Child object: `ReviewPass`

A session can contain multiple passes.

A pass represents one bounded review attempt against a specific environment state.

A pass should capture:

- session id
- workspace id
- environment revision marker
- review basis (`checkpoint` or `environment`)
- findings summary
- evidence collected
- whether fixes were attempted after this pass

This can reuse most of the current review-run implementation rather than requiring a brand-new engine.

## Mutable environment model

Nimbus should support two explicit review bases:

1. `checkpoint`
   - immutable baseline
   - trusted provenance anchor
   - ideal for the first pass in a session

2. `environment`
   - mutable current workspace state
   - used after fixes or manual edits
   - ideal for iterative re-review within the same session

This distinction matters. It should remain explicit in the system even if the UI does not over-expose the jargon.

## Branch handling

Branch should be treated as a lookup hint and a UX context, not as the only identity key.

Good uses of branch:

- find current session
- label current context
- suggest reuse candidates

Bad use of branch:

- define the canonical review target by itself

A branch moves too often to be the only durable review identity.

## Confidence model

Nimbus should not treat "no findings" as enough.

A strong session outcome should include:

- what Nimbus reviewed
- what Nimbus changed
- what checks passed
- what remains unresolved
- why the session stopped
- what the residual risk is

A session can complete in several honest ways:

- clean: no actionable findings remain and verification evidence is good
- converged with human blockers: only product-decision blockers or explicitly user-held blockers remain
- blocked: Nimbus could not continue safely
- exhausted: iteration budget was hit without meaningful convergence

## Local-first return path

Nimbus should prioritize local-first workflows.

The preferred first return path is:

- cloud workspace -> patch artifact -> local managed branch or worktree

This means:

1. Nimbus converges the change in the cloud workspace.
2. Nimbus produces an explicit patch artifact from the authoritative workspace diff.
3. The local Nimbus runtime downloads that patch.
4. The local runtime creates a fresh local branch or worktree from the original anchor commit.
5. The local runtime applies the patch there.
6. The user inspects or continues work from that local branch/worktree.

### Why this is the preferred first path

- it preserves local-first iteration
- it avoids mutating the user's current checkout implicitly
- it gives Nimbus a clean safety boundary for conflicts and drift
- it keeps the cloud workspace authoritative during the session
- it produces a local result the user can inspect with normal git tooling

### Preferred form: local managed worktree or branch

Nimbus should prefer creating a new local worktree or branch over applying changes directly into the user's current working tree.

`worktree` is probably the safer default when available because it:

- avoids disrupting the user's current checkout
- makes side-by-side inspection easier
- contains apply failures more cleanly

`branch` is also acceptable as a first-cut return path when worktree support is not yet ready.

### Explicitly not the first path

Do not make these the primary first-cut return paths:

- direct apply into the user's current branch/working tree
- Nimbus acting as a hosted git remote that the user fetches from
- PR-first as the only supported completion path

These can exist later, but they should not displace the local managed branch/worktree path in the first serious session-based implementation.

### Safety rules for local return

The local runtime should verify at least:

- the expected repo root matches
- the expected anchor commit/checkpoint still matches
- the target branch/worktree is freshly created or otherwise known-safe
- patch application succeeds cleanly

If those checks fail, Nimbus should stop and explain why rather than partially mutating the local repo.

## Design guardrails

Every implementation slice should respect these rules.

1. One user request should open one bounded session, not one static report.
2. Checkpoint-based reviews remain the clean provenance anchor for fresh sessions.
3. Mutable environment reviews are allowed only when explicitly tied to a session environment.
4. Reuse identical review bases aggressively before adding more infrastructure.
5. D1 remains the durable source of truth.
6. DOs are coordinators, not replacements for sandboxes or D1.
7. Prefer destructive simplification over adapters for legacy flows.
8. Avoid inventing more top-level concepts than necessary.
9. Local-first return should prefer creating a managed local branch/worktree over mutating the user's current checkout directly.

## Recommended implementation stance on complexity

The next wave of work should add one major new layer, not five.

Recommended new first-class layer:

- `ReviewSession`

Recommended not to add unless clearly needed:

- separate `WorkspaceSession` object in the first cut
- additional Durable Objects beyond what the session needs for live coordination
- dual legacy-and-new UI flows kept alive for long periods

If the current workspace object can serve as the mutable environment owned by a session, use that instead of inventing a second environment record immediately.

## Proposed vertical slices

Each slice should be implemented end-to-end across backend, CLI, UI, and docs where relevant.

## Slice 0: Commit to the new model and delete obvious legacy drag

### Objective

Freeze the product direction so future work stops optimizing the wrong loop.

### User-visible result

- docs and product language consistently describe review as a session-based flow
- obviously obsolete compatibility-first paths are removed or clearly demoted

### Primary work

- document the new product model
- stop teaching `review open` as a primary concept
- mark report-first assumptions as legacy where needed
- identify which old Review Studio docs are current-state references versus historical context

### Primary code/docs areas

- `docs/architecture/review-session-pivot.md`
- `docs/architecture/README.md`
- `docs/architecture/architecture.md`
- CLI help / command docs under `packages/cli/src/cli/*`

### Exit criteria

- new session-based direction is the documented default
- future sessions can read one doc and understand the pivot

### Explicitly out of scope

- no backend data model changes yet

## Slice 1: Reuse identical checkpoint review bases

### Objective

Eliminate avoidable setup waste before adding new orchestration layers.

### User-visible result

- repeated reviews of the same checkpoint/commit stop paying full workspace/deployment setup cost when equivalent reusable artifacts already exist

### Why this matters first

The current system creates fresh workspaces too eagerly in the commit-based flow. That is real waste and should be fixed regardless of the later session model.

### Primary work

- add content-aware reuse lookup for equivalent review setup
- prefer existing ready workspace/deployment when the source bundle, commit, project root, and relevant deployment params match
- keep provenance explicit so reuse is explainable

### Primary code areas

- `packages/cli/src/app/reviews/context.ts`
- `packages/cli/src/app/reviews/create-shared.ts`
- `packages/cli/src/app/reviews/create-from-commit.ts`
- `packages/worker/src/api/workspaces/create.ts`
- `packages/worker/src/api/workspace-deployments/create.ts`
- `packages/worker/src/lib/db/workspaces/*`
- `packages/worker/src/lib/db/deployments/*`

### Exit criteria

- identical checkpoint-based reviews can reuse existing setup when safe
- the reuse rules are deterministic and inspectable
- repeated review of the same target is materially faster/cheaper

### Explicitly out of scope

- no auto-fix loop yet
- no session object yet

## Slice 2: Introduce `ReviewSession` as a first-class persisted object

### Objective

Make one review request map to one durable session instead of one isolated review pass.

### User-visible result

- user starts a review session, not just a single review run
- UI can display session phase and pass history coherently

### Primary work

- add D1-backed session record and events
- define session phases and stopping reasons
- map one initial checkpoint review pass into the session
- keep existing review-run machinery as the engine for a pass rather than rewriting it immediately

### Primary code areas

- `packages/worker/src/types.ts`
- `packages/worker/src/lib/db/*`
- `packages/worker/src/api/reviews/*` or new `packages/worker/src/api/review-sessions/*`
- `packages/cli/src/app/reviews/*`
- `packages/report-ui/src/App.tsx`
- `packages/report-ui/src/components/*`

### Exit criteria

- review session exists as a durable backend object
- one user action starts a session and its first pass
- UI can show a session-level state even if only one pass exists initially

### Explicitly out of scope

- no automatic fixing yet

## Slice 3: Promote environment-backed re-review inside the same session

### Objective

Make iterative re-review happen inside the same mutable environment rather than forcing fresh checkpoint setup for each cycle.

### User-visible result

- once a session has an active workspace, Nimbus can review the current environment state inside that same session
- manual or automated changes can be re-reviewed without bouncing back to the full initial setup path

### Primary work

- promote `reviewBasis=environment` into the real session flow
- tie environment review explicitly to the session's active workspace
- define environment revision markers or equivalent provenance so repeated passes are traceable
- keep reset-to-baseline behavior available when needed

### Primary code areas

- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/reviews/policy.ts`
- `packages/cli/src/app/reviews/create-from-deployment.ts`
- `packages/cli/src/app/reviews/studio-create.ts`
- `packages/worker/src/api/workspaces/reset.ts`
- `packages/worker/src/api/workspaces/query-diff.ts`

### Exit criteria

- a session can run at least one pass against checkpoint basis and later passes against environment basis
- environment re-review does not require the user to create a fresh external review target manually
- provenance clearly distinguishes checkpoint-based versus environment-based passes

### Explicitly out of scope

- no full auto-fix loop yet

## Slice 4: Bounded internal remediation loop

### Objective

Remove the user from the boring middle of review, fix, rerun, repeat.

### User-visible result

- Nimbus can take findings from a pass, apply safe fixes, rerun verification and review, and continue for a limited number of cycles inside one session

### Primary work

- classify findings by fixability and risk
- invoke workspace tasks for safe remediation inside the active workspace
- re-run verification and then the next review pass automatically
- define hard stop conditions:
  - max cycles
  - no progress
  - risky/unresolved blocker
  - product decision required

### Primary code areas

- `packages/worker/src/api/workspace-tasks.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`
- `packages/worker/src/lib/review-runner.ts`
- `packages/worker/src/lib/review-runner/*`
- session orchestration layer introduced in Slice 2
- UI session progress surfaces in `packages/report-ui`

### Exit criteria

- one session can perform at least one review -> fix -> re-review loop internally
- the loop is bounded and observable
- the session stops honestly when it should stop

### Explicitly out of scope

- perfect autonomous coding
- unbounded autonomous repair

## Slice 5: Local-first return path

### Objective

Bring converged session changes back to the user's machine in a way that feels seamless but stays safe.

### User-visible result

- Nimbus can materialize converged session changes into a new local branch or worktree
- the user's current checkout is not mutated implicitly
- local-first iteration remains the default product path

### Primary work

- add explicit worker export path for the session's authoritative diff artifact when needed
- add local runtime flow to fetch the patch artifact
- create a fresh local branch or worktree from the session anchor commit
- apply the patch there and report success or conflicts clearly
- make this path the preferred completion action for converged local-first sessions

### Primary code areas

- `packages/worker/src/api/workspaces/operations-export.ts`
- `packages/worker/src/api/workspaces/artifacts.ts`
- `packages/cli/src/app/reviews/session.ts`
- `packages/cli/src/app/reviews/ui-proxy.ts`
- `packages/cli/src/app/reviews/*`
- `packages/cli/src/lib/checkpoint/git.ts`
- CLI command surface for local branch/worktree materialization
- UI completion actions in `packages/report-ui`

### Exit criteria

- Nimbus can bring converged session changes into a new local branch or worktree
- the current working tree is never implicitly modified
- failure modes for drift/conflict/apply errors are explicit and recoverable

### Explicitly out of scope

- no direct apply into the current checkout
- no Nimbus-hosted git remote
- no PR-first requirement

## Slice 6: Confidence and final outcome model

### Objective

Make the final outcome trustworthy enough that the user is not forced to reconstruct what happened.

### User-visible result

A completed session clearly answers:

- what Nimbus reviewed
- what Nimbus changed
- what evidence passed
- what remains unresolved
- why the session stopped
- what the residual risk is

### Primary work

- define final outcome schemas
- collect evidence across passes
- summarize applied fixes and unresolved blockers
- distinguish:
  - clean convergence
  - converged with blockers
  - blocked
  - exhausted

### Primary code areas

- session persistence schema
- review finalization code
- report/session summary UI
- CLI output formatting for session completion

### Exit criteria

- user no longer needs to inspect raw pass history just to know whether Nimbus got to a good stopping point
- the session final output is evidence-based rather than just "no findings"

### Explicitly out of scope

- no attempt to fake certainty where evidence is weak

## Slice 7: Live coordination and optional session DO

### Objective

Only if needed, add live coordination to keep session concurrency, cancellation, and progress cleaner.

### User-visible result

- better live progress
- better cancellation/recovery
- cleaner handling when multiple actors try to touch the same session environment

### Recommendation

This slice should not happen by default.

Do it only if D1 + queues + current orchestration feel too awkward for:

- live fanout
- single-writer environment mutation
- cancellation/recovery
- concurrency control

### If adopted

Use a dedicated session coordinator DO for:

- lease/lock management
- live phase tracking
- event fanout
- cancellation
- sequencing of fix/review operations

Do not use the DO as the only durable state store.

### Exit criteria

- session coordination complexity is reduced, not increased
- D1 remains the durable source of truth

## Recommended order

Implement in this order unless evidence proves otherwise:

1. Slice 0: direction + cleanup
2. Slice 1: reuse identical checkpoint review bases
3. Slice 2: persisted review session object
4. Slice 3: environment-backed re-review
5. Slice 4: bounded internal remediation loop
6. Slice 5: local-first return path
7. Slice 6: confidence/final outcome model
8. Slice 7: optional session DO if coordination pain justifies it

This order matters.

It avoids building a fancy session abstraction on top of obviously wasteful environment setup.

## Recommended destructive simplifications

Because there are zero users today, Nimbus should prefer simplification over compatibility.

Reasonable destructive actions include:

- removing or heavily demoting `review open`
- stopping documentation of report-first flows as the main product path
- deleting obsolete compatibility branches/routes if the new session flow replaces them cleanly
- renaming UI surfaces from "report" semantics to "session" semantics when the new model lands

## What should not be thrown away

Even with destructive simplification, these should be preserved and reused:

- workspace model
- sandbox integration
- review events/event persistence
- workspace task runner
- review runner orchestration
- queue infrastructure
- D1 persistence layer

## Risks and failure modes

The redesign can still go wrong.

### Risk 1: false confidence

If Nimbus simply keeps fixing until review goes quiet, it can look autonomous without actually becoming trustworthy.

Mitigation:

- require evidence-based final outcomes
- keep stop reasons explicit
- treat "quiet review" as insufficient by itself

### Risk 2: too many new layers

If Nimbus adds session objects, environment objects, pass objects, DO coordinators, and compatibility routes all at once, the redesign will collapse under its own complexity.

Mitigation:

- add one major new first-class layer: `ReviewSession`
- defer a session DO until justified
- reuse workspaces rather than inventing a new mutable-environment object immediately

### Risk 3: collapsing immutable and mutable review into one muddy concept

That would weaken provenance and make outcomes harder to trust.

Mitigation:

- keep checkpoint and environment review bases explicit in the backend
- preserve a clean immutable anchor for fresh sessions

### Risk 4: letting deployment vocabulary dominate the product

Deployment may still be a useful internal artifact, but if it leaks too hard into the review product it will make the UX harder to understand.

Mitigation:

- keep deployment internal where possible
- present review-session language to the user

### Risk 5: unsafe or confusing local apply behavior

If Nimbus mutates the user's current checkout directly, drift and partial-apply problems will make the product feel dangerous quickly.

Mitigation:

- prefer a managed local branch/worktree return path
- require anchor validation before apply
- fail explicitly instead of mutating the current checkout partially

## Open questions to resolve during implementation

These do not need to be solved before work starts, but they do need explicit answers along the way.

1. Should a review pass continue to target `workspace_deployment`, or should a later slice allow direct workspace-backed review passes?
2. Does the first cut need a new session DO, or is D1 + queues enough initially?
3. What is the minimum environment revision marker needed to make environment-based passes auditable?
4. Should worktree or branch be the first local materialization default?
5. Which verification signals are required for a session to count as "clean"?
6. How much of the current `ReportPage.tsx` should survive the session pivot versus be replaced outright?

## Suggested file map for future sessions

If a future session is starting this work, these are the most important files to inspect first.

### Product and planning docs

- `docs/architecture/architecture.md`
- `docs/architecture/review-session-pivot.md`
- `docs/architecture/review-studio-implementation-plan.md`
- `docs/architecture/review-studio-experience.md`

### CLI review flow

- `packages/cli/src/app/reviews/context.ts`
- `packages/cli/src/app/reviews/create-from-commit.ts`
- `packages/cli/src/app/reviews/create-from-deployment.ts`
- `packages/cli/src/app/reviews/studio-create.ts`
- `packages/cli/src/app/reviews/open.ts`
- `packages/cli/src/app/reviews/session.ts`
- `packages/cli/src/app/reviews/ui-proxy.ts`
- `packages/cli/src/app/reviews/ui-events-fanout.ts`

### Worker review flow

- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/reviews/policy.ts`
- `packages/worker/src/api/reviews/recovery.ts`
- `packages/worker/src/lib/review-runner.ts`
- `packages/worker/src/lib/review-runner/*`
- `packages/worker/src/review-runner-do.ts`

### Worker workspace and mutation flow

- `packages/worker/src/api/workspaces/create.ts`
- `packages/worker/src/api/workspaces/reset.ts`
- `packages/worker/src/api/workspaces/query-diff.ts`
- `packages/worker/src/api/workspaces/ready.ts`
- `packages/worker/src/api/workspaces/sandbox-client.ts`
- `packages/worker/src/api/workspace-tasks.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`
- `packages/worker/src/lib/db/*`

### UI

- `packages/report-ui/src/App.tsx`
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- `packages/report-ui/src/components/ReportPage.tsx`
- `packages/report-ui/src/lib/review.ts`

## Bottom line

Nimbus does not need an entirely new platform to get out of review hell.

It needs to stop treating review as a static report and start treating one review request as a bounded session that can:

- reuse setup intelligently
- operate against a mutable environment when appropriate
- fix what is safe to fix
- re-review automatically
- stop honestly with evidence

That is the pivot.
