# Nimbus Refactor Audit Phase 5 Handoff

## Status

- State: current refactor handoff for readability cleanup
- Scope: follow-on cleanup after the main CLI/worker structural refactor
- Use this for: the active refactor workstream and guardrails

Read alongside:

- `docs/refactor-baseline.md` for the historical baseline and known-red verification gaps
- `docs/refactor-audit.md` for the original cleanup rationale and target architecture
- `docs/architecture/architecture.md` for the current repo structure
- `docs/architecture/review-studio-implementation-plan.md` for current Review Studio delivery status

## Important note

This handoff is current for CLI/worker readability cleanup.

It is not the source of truth for current Review Studio product delivery in `packages/report-ui`; that status now lives in the Review Studio docs under `docs/architecture/`.

## Purpose

This document is the handoff for the next refactor session.

Phase 4 architecture work is effectively complete for the scope we actively refactored:

- `packages/cli`
- `packages/worker`

We intentionally did **not** refactor `packages/report-ui` in the previous branch because the likely direction is a larger redesign rather than incremental structural cleanup.

This handoff is for the next phase of work: improving syntax and local readability without undoing the architectural boundaries that were just established.

## Current State

### What was completed

- CLI command dispatch was split by domain.
- CLI review, workspace, job, and local UI flows were moved into app/domain-oriented modules.
- Worker review routes were split into route, policy, request, recovery, queue, and event-stream modules.
- Worker workspace routes were split into create, reset, delete, query, diff, file, operation, GitHub, and sandbox-focused modules.
- Worker support code was flattened into smaller modules for GitHub auth/branch/push/client logic and sandbox access/command/git/filesystem/analysis helpers.
- `packages/worker/src/lib/db.ts` was reduced close to a pure export surface, with more domain-specific DB modules underneath.
- Architecture docs, module docs, ADR scaffolding, and Entire recovery docs were added.

### What is intentionally unfinished

- `packages/report-ui`
- test-runner modernization and migration to dedicated `test/` directories
- local readability and syntax cleanup inside the newly split modules

## Phase 5 Goal

Phase 5 is **not** another broad file-splitting phase.

The goal is to make the newly separated modules easier for a human engineer to read and reason about.

That means:

- remove repeated helpers that only existed because earlier files were too large
- reduce nested conditionals and control-flow noise
- normalize naming where boundaries are now clear
- simplify validation, shaping, and mapping code where behavior is already pinned down
- reduce transport-specific noise inside business logic
- add JSDoc selectively where orchestration or invariants are subtle

This phase should preserve the architecture that now exists instead of creating new parallel structures.

## Guardrails

- No behavioral regressions.
- Prefer small, reviewable commits.
- Do not fold large product UX redesign work into general readability cleanup.
- Keep tests/build green before each commit.
- After each commit, run review preflight to confirm Entire checkpoint reviewability still works.
- Do not touch `packages/report-ui` unless there is an explicit decision to start the redesign there.

## Verification Workflow

Before each commit:

```bash
pnpm --filter @dayhaysoos/nimbus-worker test
pnpm --filter @dayhaysoos/nimbus test
pnpm --filter @dayhaysoos/nimbus build
```

After each commit:

```bash
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review preflight HEAD
```

If preflight fails, fix that immediately before continuing.

## Recommended Phase 5 Order

### 1. CLI local readability pass

Primary targets:

- `packages/cli/src/app/reviews/*`
- `packages/cli/src/app/workspaces/*`
- `packages/cli/src/clients/worker/*`

Focus:

- reduce duplicated option normalization
- simplify review-open lifecycle handling
- tighten naming and reduce wrapper/helper churn
- add JSDoc only where orchestration or failure behavior is subtle

### 2. Worker route-support readability pass

Primary targets:

- `packages/worker/src/api/reviews/*`
- `packages/worker/src/api/workspaces/*`
- `packages/worker/src/lib/db/*`

Focus:

- simplify route helper control flow
- normalize request/response shaping code
- reduce repeated “best-effort” failure handling boilerplate where patterns are now obvious
- add JSDoc to important orchestration and state-transition functions

### 3. Decide report-ui strategy explicitly

Do not drift into opportunistic `report-ui` edits.

Instead decide one of these first:

1. keep `report-ui` mostly as-is and do a normal Phase 3/4 pass later
2. redesign `report-ui` more substantially and treat that as a separate effort

Until that decision is made, avoid touching it in general readability cleanup.

## Good Phase 5 Candidates

Examples of work that fits this phase:

- collapsing duplicate option parsing that now sits across two neighboring modules
- replacing deeply nested `if`/`else` blocks with early returns where behavior stays the same
- renaming ambiguous helpers after boundaries are already clear
- reducing repeated event/response assembly boilerplate
- tightening error messages for clarity when the underlying behavior does not change
- adding short JSDoc to orchestration-heavy exported functions

## Bad Phase 5 Candidates

Examples of work that does **not** fit this phase:

- large UI redesigns mixed into readability cleanup
- test-runner migration combined with business-logic edits
- reshaping the new module tree again without a strong reason
- broad rewrites of stable code “just because it could be shorter"

## JSDoc Guidelines For Phase 5

Use the guidance from `docs/jsdoc-guidelines.md` while doing this work.

The key rule is:

> Use JSDoc where a reader would otherwise need to reverse-engineer intent, invariants, side effects, or state transitions.

### Add JSDoc To

- orchestration functions
- functions with important invariants
- functions with side effects across boundaries
- exported functions that define module behavior
- subtle internal functions that are easy to misuse

Examples from the guideline:

- review lifecycle handlers
- workspace lifecycle handlers
- queue dispatch and retry paths
- deployment orchestration
- branch naming / signing / token flows
- diff truncation / event replay rules

### Do Not Add JSDoc To

- tiny obvious helpers
- mechanical wrappers
- comments that only restate syntax

Bad examples:

- "Gets the workspace"
- "Parses a boolean"

### Preferred Style

- keep it short
- prefer 2-6 lines
- explain behavior and constraints, not obvious syntax
- use `@param` / `@returns` only when they add real clarity

### Application Rule

Do not stop progress to backfill JSDoc everywhere.

Instead:

1. add JSDoc to meaningful new or newly cleaned-up orchestration boundaries
2. add JSDoc when already touching an important function
3. avoid mass comment-only churn on trivial helpers

## Exit Criteria For Phase 5

This phase is done when:

- the current architecture remains intact
- local module readability is materially better
- repeated noise is reduced
- important orchestration/state-transition functions are documented where needed
- tests still pass
- review preflight still works on new commits

## Final Note

The previous branch did the hard structural work.

The next branch/session should be disciplined about **not reopening architecture unnecessarily**. The value now comes from making the already-improved structure easy to read, easy to debug, and easy to extend.
