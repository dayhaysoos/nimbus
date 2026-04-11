# Nimbus Refactor Audit

## Status

- State: foundational refactor program document
- Use this for: the original cleanup rationale, refactor ordering, and target package shape
- Do not use this for: the current repo structure or the current implementation handoff

Read alongside:

- `docs/refactor-baseline.md` for the historical pre-refactor verification snapshot
- `docs/refactor-audit-phase-5.md` for the current refactor handoff/status
- `docs/architecture/architecture.md` for the current source-of-truth architecture

## Important note

Parts of the target structure described here have already landed, especially in `packages/cli` and `packages/worker`.

Treat this document as the original refactor rationale and target-direction record, not as the best description of the repo as it exists today.

## Purpose

This document is the starting point for a large-scale cleanup of Nimbus.

The goal is not to rewrite the app for novelty. The goal is to make the codebase easier for a human engineer to understand, change, debug, and document without regressing the currently working behavior.

## Primary Constraints

- No regressions to current behavior.
- Prefer small, reviewable changes over broad rewrites.
- Improve readability in both file structure and syntax.
- Move toward simpler architecture designed from first principles.
- End state should place tests in dedicated `test/` directories rather than colocated with source.
- The redesign must be heavily documented as it proceeds.

## Executive Summary

The codebase already implements a real product, but it is carrying a large amount of accidental complexity.

The main issues are not that the code is TypeScript, Cloudflare, or monorepo-based. The main issues are:

- too many files acting as routers, orchestrators, validators, serializers, and integration layers at the same time
- very large files that mix concerns and hide the real domain boundaries
- custom test runners that make simple organization changes harder than they should be
- repeated parsing and normalization logic spread across packages
- UI components that mix data loading, event streaming, transformation, and presentation in a single file
- documentation that explains usage, but not enough of the internal architecture or the reasoning behind core flows

Because of that, the cleanup plan should establish a behavioral baseline, define target module boundaries, and then refactor the worst files in a controlled order. Test migration should happen in a way that matches the clarified architecture.

## Current State Assessment

### What is working

- The product has a coherent end-to-end review flow across CLI, worker, agent endpoint, and report UI.
- The repo already has non-trivial test coverage.
- The docs explain how to run the system and how the product works at a high level.
- The packages have clear top-level responsibilities.

### What is hard to work with

- `packages/worker/src/lib/db.ts` is extremely large and appears to centralize too many unrelated persistence responsibilities.
- `packages/worker/src/api/workspaces.ts` mixes HTTP handling, sandbox operations, artifact/export logic, GitHub operations, file system hydration, and operation orchestration.
- `packages/worker/src/api/reviews.ts` mixes transport, retry/recovery logic, policy handling, SSE behavior, validation, and request parsing.
- `packages/worker/src/lib/review-runner.ts` is functioning as an application service, integration layer, prompt builder, context assembler, and lifecycle coordinator in one place.
- `packages/cli/src/index.ts` is too large for a command entrypoint and is carrying command-dispatch complexity that should be easier to scan.
- `packages/cli/src/commands/review/create.ts` and `packages/cli/src/commands/review/open.ts` are both doing too much orchestration inline.
- `packages/cli/src/lib/api.ts` is a large hand-written API client with repeated response/error patterns.
- `packages/report-ui/src/components/ReportPage.tsx` is large enough that reading it likely means reconstructing multiple hidden sub-systems at once.
- Worker, CLI, and agent-endpoint tests are tied to hand-maintained `run-tests.ts` files rather than discovery-based test execution.

## First Principles For The Redesign

Every refactor should be judged against these rules.

### 1. One file should have one reason to change

If a file changes for routing, persistence, validation, provider integration, and presentation reasons, it is not a coherent module.

### 2. Transport should not own business logic

HTTP handlers should parse requests, invoke application services, and serialize responses. They should not contain the core domain workflow.

### 3. Orchestration should be explicit

The important product flows are orchestration-heavy. That is fine. What is not fine is hiding orchestration inside giant route files and giant components.

### 4. Domain vocabulary should be visible in the folder structure

Humans should be able to answer these questions by looking at the tree:

- Where is review creation handled?
- Where is workspace deployment handled?
- Where is persistence for reviews?
- Where are provider integrations?
- Where are contract validators?

### 5. Tests should mirror architecture, not accidental file placement

Moving tests into `test/` is good, but the test tree should mirror the target runtime structure, not preserve a messy runtime layout forever.

### 6. Documentation is part of the architecture

If the system cannot be understood without reverse-engineering giant files, the architecture is incomplete.

## Recommended Refactor Order

This is the recommended order for the cleanup program.

### Phase 0: Stabilize Behavior Before Architecture Changes

Goals:

- Freeze current behavior through characterization tests and flow documentation.
- Establish refactor safety rails before moving files around.

Work:

- Define the critical end-to-end behaviors that must not regress.
- Identify the core contracts between packages.
- Add missing high-value tests only where current behavior is not adequately pinned down.
- Write architecture notes for the current system before changing it.

This phase should produce a behavior inventory, not a rewrite.

### Phase 1: Introduce Documentation As A First-Class Artifact

Goals:

- Make the current system legible.
- Create a place for the redesign to accumulate decisions.

Work:

- Add an architecture overview document.
- Add ADR-style records for major structural decisions.
- Add flow docs for the major product paths.
- Document module responsibilities before splitting them.

This should happen in parallel with refactoring, not after.

### Phase 2: Standardize The Test Strategy

Goals:

- Move toward discovery-based test execution.
- End state: tests live in dedicated `test/` directories.

Current constraint:

Right now the worker, CLI, and agent-endpoint tests are imported manually from custom runners:

- `packages/worker/src/lib/run-tests.ts`
- `packages/cli/src/lib/run-tests.ts`
- `packages/agent-endpoint/src/lib/run-tests.ts`

Because of that, test migration is a behavioral refactor, not a cosmetic one.

Recommended sequence:

1. Pick a standard runner strategy package by package.
2. Convert one package at a time.
3. Move tests into `test/` only after the package can discover them cleanly.
4. Keep runtime code and test harness changes isolated from business-logic refactors.

### Phase 3: Split The Largest Mixed-Concern Files

This is where readability gains will be biggest.

Start with the files that currently hide the most architecture:

1. `packages/worker/src/api/workspaces.ts`
2. `packages/worker/src/api/reviews.ts`
3. `packages/worker/src/lib/review-runner.ts`
4. `packages/worker/src/lib/db.ts`
5. `packages/report-ui/src/components/ReportPage.tsx`
6. `packages/cli/src/commands/review/open.ts`
7. `packages/cli/src/commands/review/create.ts`
8. `packages/cli/src/lib/api.ts`
9. `packages/cli/src/index.ts`

### Phase 4: Align Folder Structure With The Actual Domain

After the large files are split, restructure packages so the tree expresses the product model clearly.

### Phase 5: Improve Syntax And Local Readability

After architecture is cleaner, simplify local syntax:

- remove repeated helpers that only exist because files are oversized
- reduce nested conditionals
- normalize naming
- reduce transport-specific noise in business logic
- simplify validation and mapping code where safe

## Proposed Target Architecture By Package

These are not rigid laws. They are the default direction unless the code proves otherwise.

### Worker

Current role:

- HTTP API
- queues
- durable object handoff
- persistence
- sandbox orchestration
- review orchestration
- auth and admin flows

Target shape:

```text
packages/worker/
  src/
    index.ts
    routes/
      reviews/
      workspaces/
      deployments/
      checkpoint-jobs/
      auth/
      admin/
      repos/
      system/
    services/
      reviews/
      workspaces/
      deployments/
      checkpoints/
    domain/
      reviews/
      workspaces/
      jobs/
    persistence/
      reviews/
      workspaces/
      jobs/
      runtime-flags/
    integrations/
      sandbox/
      github/
      openrouter/
      queues/
      r2/
    contracts/
      reviews/
      workspaces/
      auth/
    lib/
      shared utilities only
    test/
      routes/
      services/
      domain/
      persistence/
      integrations/
```

Worker-specific refactor priorities:

- split route parsing/serialization from workflow logic
- remove giant persistence bucket files in favor of domain-specific repositories
- isolate sandbox/GitHub/provider code behind small integration modules
- keep retry and queue semantics in dedicated services rather than route handlers

### CLI

Current role:

- argument parsing
- command dispatch
- API client
- local git/checkpoint/context resolution
- orchestration for review/workspace flows
- local static UI server

Target shape:

```text
packages/cli/
  src/
    index.ts
    commands/
      review/
      workspace/
      deploy/
      auth/
      repo/
      admin/
    app/
      reviews/
      workspaces/
      checkpoints/
    clients/
      worker/
    git/
    entire/
    ui-server/
    contracts/
    test/
      commands/
      app/
      clients/
      git/
      entire/
```

CLI-specific refactor priorities:

- reduce `index.ts` to a thin entrypoint and command registration layer
- pull multi-step review and workspace flows into application services
- split the worker API client into grouped domain clients rather than one giant module
- isolate the local UI server from review flow logic

### Report UI

Current role:

- data loading
- lifecycle polling/streaming
- transformation/parsing
- UI rendering
- download/copy helpers

Target shape:

```text
packages/report-ui/
  src/
    app/
      routes/
      loaders/
    features/
      review-history/
      branch-reviews/
      report/
      policy/
    components/
      ui/
      shared/
    lib/
      api/
      parsing/
      formatting/
    test/
      features/
      lib/
```

UI-specific refactor priorities:

- split container/data logic from presentational components
- move timeline parsing, status derivation, and markdown normalization out of `ReportPage.tsx`
- keep feature state close to feature folders rather than one giant component file

### Agent Endpoint

Current role:

- authenticated inference endpoint
- review output validation
- lightweight workspace-task action loop

Target shape:

```text
packages/agent-endpoint/
  src/
    index.ts
    routes/
    services/
      reviews/
      tasks/
    contracts/
    integrations/
      openrouter/
    test/
      routes/
      services/
      contracts/
```

Agent-endpoint-specific refactor priorities:

- separate review-output validation from endpoint handling
- separate task-agent behavior from review-agent behavior
- keep sanitization logic close to transport boundaries

## Test Strategy

## End State

- All packages use a standard discovery-based runner or a small standardized wrapper over discovery.
- Tests live under package-level `test/` directories.
- The test tree mirrors runtime architecture.
- Contract tests, integration tests, and end-to-end smoke tests are intentionally separated.

## Recommended Migration Sequence

### 1. Preserve current coverage first

Before moving files, make sure each package test suite is passing from a reproducible command.

### 2. Standardize one package at a time

Recommended order:

1. `report-ui`
2. `agent-endpoint`
3. `cli`
4. `worker`

Reason:

- `report-ui` already uses Vitest and is closest to the desired shape
- `agent-endpoint` is smaller
- `cli` has moderate orchestration complexity
- `worker` is the highest-risk package and should benefit from lessons learned first

### 3. Introduce test categories

Suggested structure:

```text
test/
  unit/
  contract/
  integration/
  e2e/
```

This can be adopted package by package rather than all at once.

### 4. Keep test migrations separate from logic refactors

Do not combine these in one PR unless the change is tiny. It becomes too hard to detect regressions.

## Documentation Program

Documentation should be built alongside the refactor. The app needs one accurate current-state architecture document plus narrower implementation docs where complexity still justifies them.

## Required Document Types

### 1. Current-State Architecture Document

Purpose:

- explain the package boundaries
- explain runtime boundaries
- explain the main request, queue, and UI flows
- clearly separate what is implemented today from what is still planned

Suggested path:

- `docs/architecture/architecture.md`

This document should be the first thing a new engineer or LLM reads.

### 2. Module Docs For Important Subsystems

Not every flow needs its own file.

Write a focused module doc only when a subsystem still has enough sequencing, retries, state transitions, or provider behavior that a reader would otherwise need to reverse-engineer the code.

Suggested path:

- `docs/modules/`

Each module doc should answer:

- what the subsystem owns
- the major steps in order
- important inputs and outputs
- state transitions
- retry/cancellation behavior
- failure modes
- source files that currently implement it

### 3. ADRs

Use short architecture decision records for significant structural changes.

Suggested path:

- `docs/architecture/adr/`

Examples:

- why tests moved to `test/`
- why worker routes were split from services
- why domain repositories were separated from `db.ts`
- why a given runner or contract strategy was chosen

### 4. Module Docs For Important Subsystems

Some modules are complex enough to deserve focused documents even after cleanup.

Likely candidates:

- review context assembly
- review execution and retries
- workspace deployment preflight and execution
- auth exchange and hosted auth model
- sandbox file hydration/export/fork operations

Suggested path:

- `docs/modules/`

### 5. Function-Level Documentation

Do not document every function. That becomes noise.

Document only the functions that are:

- orchestration-heavy
- stateful
- subtle in correctness requirements
- critical for security, retries, or state transitions

Preferred form:

- concise doc comments near the function
- linked module docs for the full explanation

## Documentation Rules

- Documents should explain why the system is shaped the way it is, not just restate code.
- Documents should link to source files and key entrypoints.
- Any major refactor should update both architecture docs and ADRs when applicable.
- If a subsystem cannot be explained clearly in one document, it is likely still architecturally muddy.

## Refactor Playbook

This should be the default workflow for major changes.

1. Identify one flow or one oversized file.
2. Write down the current behavior and invariants.
3. Add or confirm test coverage for that behavior.
4. Extract coherent submodules without changing behavior.
5. Move logic behind clearer names and boundaries.
6. Update docs.
7. Only then consider local syntax cleanup.

## Safety Rules For This Cleanup Program

- No large rewrites without characterization coverage.
- No combining file moves, runner changes, and logic changes unless the scope is tiny.
- Keep transport-level contract behavior stable unless a deliberate API change is documented.
- Prefer extracting code over rewriting code.
- Keep existing behavior even when the current design is awkward, unless a change is intentionally approved.

## Suggested Initial Work Queue

This is the order recommended for the next several rounds of work.

### Round 1

- Create architecture docs scaffold.
- Document the current review flow and workspace flow.
- Audit current test commands and establish the package-by-package migration plan.

### Round 2

- Refactor `packages/cli/src/index.ts` into a thinner command entrypoint.
- Split `packages/cli/src/lib/api.ts` into domain clients.
- Keep behavior stable.

### Round 3

- Split `packages/report-ui/src/components/ReportPage.tsx` into feature logic, timeline logic, and presentational sections.
- Add matching feature docs.

### Round 4

- Split `packages/worker/src/api/reviews.ts` into route handling, policy handling, event streaming, and retry/recovery modules.

### Round 5

- Split `packages/worker/src/api/workspaces.ts` into read routes, mutation routes, artifact/export operations, and provider integrations.

### Round 6

- Break `packages/worker/src/lib/db.ts` into domain repositories.
- Migrate worker tests to the new structure.

### Round 7

- Replace custom package test runners and move tests into `test/` package by package.

## Recommended Definition Of Done For A Refactor

A refactor is not done when the code merely compiles.

It is done when:

- behavior is unchanged or intentionally improved
- tests pass
- module boundaries are clearer than before
- file names match responsibilities
- architecture docs are updated
- any important decision is captured in an ADR if needed

## Final Recommendation

The recommended starting point is:

1. document the current architecture and critical flows
2. define target boundaries
3. refactor the worst oversized files in a controlled order
4. standardize the test runner strategy
5. move tests into `test/` in a structure that matches the improved architecture

That sequence gives the best chance of achieving the actual goal: a human-readable, well-documented codebase with simpler architecture and no regressions.
