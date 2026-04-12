# Nimbus Architecture

## Status

- State: current-state source of truth
- Last updated: 2026-04-12
- Audience: humans and LLMs that need a fast, accurate mental model of the repo

## Why this file exists

This document replaces the older per-flow baseline docs that described Nimbus before the current CLI and worker refactor landed.

Read this file first when you need to understand how the repo fits together today.

Then use the narrower docs only when you need product-planning or subsystem-specific detail:

- `docs/modules/*` for deep dives into a specific subsystem
- `docs/architecture/review-session-pivot.md` for the active session-based review redesign direction
- `docs/architecture/review-studio-experience.md` for the locked Review Studio product spec
- `docs/architecture/review-studio-implementation-plan.md` for current Review Studio slice status, shipped work, and next-slice guidance
- `docs/architecture/review-studio-experience-build-plan.md` for historical Review Studio planning context
- `docs/refactor-baseline.md` for the historical pre-refactor verification snapshot
- `docs/refactor-audit.md` for the original refactor rationale and target architecture
- `docs/refactor-audit-phase-5.md` for the current readability-cleanup handoff

## 60-second mental model

Nimbus is a checkpoint-aware code review system.

The product is built around one core path:

1. Resolve a review target from local git and Entire checkpoint context.
2. Create an isolated workspace snapshot in the backend.
3. Run deployment-style validation against that workspace.
4. Create a review run for the resulting workspace deployment.
5. Execute the review asynchronously in the worker.
6. Stream status and final findings back to CLI or UI clients.

The important runtime split is:

- `packages/cli`: local control plane, local git/Entire resolution, and Review Studio runtime
- `packages/worker`: backend source of truth for state, events, queues, auth, workspaces, deployments, and reviews
- `packages/report-ui`: browser UI used both as a direct report viewer and as the UI shell for local Review Studio
- `packages/agent-endpoint`: a separate inference-oriented endpoint that validates and constrains model-backed agent output

The worker owns truth.

The CLI and UI are clients that resolve local context, send requests, and render state, but they should not invent backend outcomes.

## What is implemented today

The repo is beyond the old "pre-refactor baseline".

The current codebase already has:

- thin CLI entrypoint and command dispatch split by domain
- worker route handlers split into smaller review/workspace/deployment modules
- worker DB access split into domain-specific modules under `src/lib/db/*`
- dedicated `test/` directories for CLI, worker, and agent-endpoint packages
- a detached local Review Studio runtime with repo-local metadata in `.nimbus/`
- a Studio-style home screen and new-review start flow in the report UI
- canonical CLI support for:
  - `nimbus review studio`
  - `nimbus review create`
  - `--policy-mode none|auto|review`
  - compatibility handling for `nimbus review open`

## What is still partial or planned

Not all Review Studio planning has landed.

Current gaps or partial areas include:

- `packages/report-ui` is still the least-refactored package and still carries large mixed-concern components
- the Review Studio spec includes worktree-backed edit/review environments and a richer fix loop that are not fully implemented in this repo yet
- the active redesign direction is now documented in `docs/architecture/review-session-pivot.md`
- that redesign now explicitly prefers a local-first return path using a managed local branch or worktree rather than PR-first completion or direct mutation of the current checkout
- the current slice-by-slice rollout status lives in `docs/architecture/review-studio-implementation-plan.md`
- the local Studio runtime already has replay-cursor metadata scaffolding, but replay persistence is not yet the center of the current implementation
- the worker accepts `reviewBasis = checkpoint|environment`, but the main user-facing Studio path is still centered on checkpoint-based review creation
- the worker standalone typecheck is still red because `Buffer` is referenced without Node types in the main worker tsconfig

## Active package map

Only four package directories are active workspace packages today:

### `packages/cli`

Responsibility:

- user-facing CLI
- local git and Entire checkpoint resolution
- local review preflight
- local Review Studio runtime startup, reuse, and status
- proxying/browser-serving for the local Studio UI

Start here when changing:

- command surface: `packages/cli/src/index.ts`, `packages/cli/src/cli/dispatch.ts`, `packages/cli/src/cli/dispatch/*`
- review create flows: `packages/cli/src/app/reviews/create-from-commit.ts`, `packages/cli/src/app/reviews/create-from-deployment.ts`
- Studio runtime: `packages/cli/src/app/reviews/session.ts`, `packages/cli/src/app/reviews/open.ts`
- Studio local endpoints: `packages/cli/src/app/reviews/ui-proxy.ts`
- event fanout/proxying: `packages/cli/src/app/reviews/ui-events-fanout.ts`

### `packages/worker`

Responsibility:

- Cloudflare Worker backend
- request auth and authorization
- D1-backed persistence
- review, workspace, deployment, and task APIs
- queue processing and Durable Object handoff
- sandbox integration and deployment/provider execution

Start here when changing:

- top-level routing: `packages/worker/src/index.ts`
- review APIs: `packages/worker/src/api/reviews/*`
- workspace APIs: `packages/worker/src/api/workspaces/*`
- deployment APIs: `packages/worker/src/api/workspace-deployments/*`
- review execution: `packages/worker/src/lib/review-runner.ts`, `packages/worker/src/lib/review-runner/*`
- persistence: `packages/worker/src/lib/db/*`

### `packages/report-ui`

Responsibility:

- browser UI for review history, branch views, Studio home, new-review flow, policy approval, and report viewing

Start here when changing:

- routing: `packages/report-ui/src/App.tsx`
- Studio home/new-review UI: `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- branch-level history: `packages/report-ui/src/components/BranchReviewsPage.tsx`
- report and policy lifecycle page: `packages/report-ui/src/components/ReportPage.tsx`
- payload parsing and UI shaping: `packages/report-ui/src/lib/review.ts`

### `packages/agent-endpoint`

Responsibility:

- separate endpoint for constrained agent/inference behavior
- structured validation of model output
- a small action loop used by backend review/task execution

Start here when changing:

- HTTP entrypoint: `packages/agent-endpoint/src/index.ts`
- model request/validation logic: `packages/agent-endpoint/src/lib/agent.ts`

## System boundaries

Nimbus has four main runtime zones.

### 1. Local machine

Owned primarily by `packages/cli`.

This layer does the work that depends on the user's repository state:

- reading git state
- resolving commit-ish inputs
- reading Entire checkpoint/session context
- collecting local co-change context when available
- launching or reusing local Review Studio
- serving the local UI shell and proxying backend requests

### 2. Cloudflare worker backend

Owned by `packages/worker`.

This is the system of record for:

- workspaces
- workspace deployments
- review runs
- lifecycle events
- hosted auth and account scoping
- runtime flags

This layer also owns queue dispatch, Durable Object handoff, and review/deployment execution orchestration.

### 3. Browser UI

Owned by `packages/report-ui`.

This layer renders:

- Studio Home
- branch review history
- review run progress
- policy approval states
- final findings and summaries

The browser does not own canonical review truth. It loads snapshots and reacts to streamed events.

### 4. Inference endpoint

Owned by `packages/agent-endpoint`.

This layer is kept separate so the worker can call a narrower endpoint for model-backed work without embedding all transport and validation rules in the main backend.

## Cloudflare and external dependencies

Nimbus depends on these external systems:

- D1: primary relational store for workspaces, deployments, reviews, events, runtime flags, and related metadata
- R2: source bundles, review context blobs, and downloadable artifacts
- KV: cached GitHub OIDC JWKS data when available
- Queues: checkpoint jobs, workspace tasks, workspace deployments, and reviews
- Durable Objects:
  - sandbox access via `@cloudflare/sandbox`
  - `ReviewRunner` for serialized review execution handoff
- OpenRouter: model-backed review analysis and intent-summary steps
- GitHub:
  - hosted auth exchange through GitHub Actions OIDC
  - repo registration and review context access
- Entire: checkpoint and session metadata used by local review resolution

## Primary runtime flows

## Flow A: review from a commit or checkpoint

Canonical entrypoint:

- `nimbus review create --commit ...`

Current flow:

1. CLI resolves commit/checkpoint context locally.
2. CLI reads Entire session metadata and local git-derived context.
3. CLI creates a workspace by uploading a source bundle to the worker.
4. Worker stores the bundle, hydrates the sandbox, and records workspace state.
5. CLI requests a workspace deployment.
6. Worker runs deployment preflight and execution, then persists deployment state and events.
7. CLI creates a review against the succeeded deployment.
8. Worker persists the review, emits creation events, and enqueues execution.
9. Review queue hands the run to the `ReviewRunner` Durable Object.
10. The worker assembles context, calls model-backed analysis, validates output, persists findings, and emits terminal events.
11. CLI or UI clients stream or poll the final result.

Primary files:

- `packages/cli/src/app/reviews/create-from-commit.ts`
- `packages/cli/src/app/reviews/context.ts`
- `packages/worker/src/api/workspaces/create.ts`
- `packages/worker/src/api/workspace-deployments/create.ts`
- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/lib/review-dispatch.ts`
- `packages/worker/src/review-runner-do.ts`
- `packages/worker/src/lib/review-runner.ts`

## Flow B: review from an existing workspace deployment

Canonical entrypoint:

- `nimbus review create --workspace <id> --deployment <id>`

Current flow:

1. CLI validates token/readiness assumptions.
2. CLI sends a review request for an existing succeeded deployment.
3. Worker validates target type, mode, policy mode, review basis, and provenance.
4. Worker persists the review and either queues it immediately or runs the policy-first path.
5. Clients consume results through polling or event streams.

Primary files:

- `packages/cli/src/app/reviews/create-from-deployment.ts`
- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/reviews/policy.ts`

## Flow C: Review Studio

Canonical entrypoint:

- `nimbus review studio`

Current flow:

1. CLI resolves repo root and checks `.nimbus/studio/runtime.json`.
2. If a healthy runtime exists, CLI reuses it.
3. Otherwise CLI launches a detached local process that serves the report UI.
4. The local Studio server serves built UI assets and proxies `/api/*` requests.
5. The Studio proxy also exposes local endpoints for branch context and new-review start flows:
   - `/api/studio/context`
   - `/api/studio/new-review/preflight`
   - `/api/studio/new-review/start`
   - `/api/studio/new-review/start/events`
6. Studio Home loads current branch context, shows recent reviews for that branch, and offers `New Review` and `Resume active review` actions.
7. Starting a new review uses local preflight/context resolution and then calls the worker policy/review lifecycle APIs.
8. The browser navigates into the single review route and then reads worker snapshots and events.

Important implementation note:

- the current local Studio transport is based on local HTTP endpoints plus worker SSE fanout
- the Review Studio product spec still describes a richer longer-term event model than what is implemented today

Primary files:

- `packages/cli/src/app/reviews/session.ts`
- `packages/cli/src/app/reviews/open.ts`
- `packages/cli/src/app/reviews/ui-server.ts`
- `packages/cli/src/app/reviews/ui-static-server.ts`
- `packages/cli/src/app/reviews/ui-proxy.ts`
- `packages/cli/src/app/reviews/studio-create.ts`
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- `packages/report-ui/src/components/ReportPage.tsx`

## Flow D: hosted auth and CI-triggered review

Current flow:

1. A repository is registered to a Nimbus account.
2. GitHub Actions requests an OIDC token for audience `nimbus`.
3. The workflow calls `/api/auth/exchange`.
4. The worker verifies the token against GitHub JWKS, validates repo claims, and mints a short-lived Nimbus JWT.
5. The workflow uses that JWT through `X-Nimbus-Api-Key` for later worker requests.
6. Review creation then follows the same worker-owned lifecycle as other review runs.

Primary files:

- `packages/worker/src/lib/auth.ts`
- `packages/worker/src/api/auth.ts`
- `packages/worker/src/api/repos.ts`
- `packages/cli/src/commands/auth/exchange.ts`
- `.github/workflows/nimbus-pr-review.yml`

## Data model and lifecycle states

The three most important persisted resource types are workspaces, deployments, and reviews.

### Workspace

Purpose:

- immutable-ish backend snapshot of uploaded source plus mutable sandbox state

States:

- `creating`
- `ready`
- `failed`
- `deleted`

Important facts:

- workspace creation stores the original source bundle in R2
- sandbox hydration happens from that stored bundle
- `baselineReady` is a meaningful secondary flag because diff/reset behavior depends on a valid git baseline

### Workspace deployment

Purpose:

- validation and provider execution record for a workspace

States:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

Important facts:

- deployments are persisted before execution begins
- preflight is a separate readiness operation
- cancellation is cooperative for running executions

### Review run

Purpose:

- persistent review lifecycle record tied to a workspace deployment

States:

- `policy_pending`
- `policy_ready`
- `policy_approved`
- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

Important facts:

- worker events are part of the public contract for CLI/UI observability
- current target type is still `workspace_deployment`
- current mode is still `report_only`
- the worker now accepts:
  - `policyMode = none|auto|review`
  - `reviewBasis = checkpoint|environment`
- policy-first flows remain a first-class part of the state machine

## Review execution model

Review execution is asynchronous and worker-owned.

The rough execution pipeline is:

1. validate request and persisted target state
2. enqueue review
3. hand off to `ReviewRunner` Durable Object
4. assemble context:
   - deployment output
   - changed files
   - diff
   - conventions
   - Entire/session context
   - co-change context
5. call the model-backed analysis path
6. validate and normalize output
7. persist findings and summary
8. emit terminal events

The key design rule is that retries, stale-running recovery, and final status are backend responsibilities, not UI responsibilities.

## Current UI shape

The UI is in a transitional but coherent state.

What is true today:

- `/` is the Studio-style home route
- branch-scoped history lives under `/branches/:repo/:branch`
- report and policy lifecycle states are rendered through `ReportPage.tsx`
- `PolicyPage.tsx` is now effectively a legacy alias wrapper around the shared review run page
- the Home page already understands:
  - current branch context
  - explicit branch switching
  - new review preflight
  - start-progress streaming
  - resume-active-review behavior

What is not yet true:

- the full Review Studio spec has not been exhaustively implemented
- `packages/report-ui/src/components/ReportPage.tsx` is still large and remains the main frontend hotspot

## Current code-health snapshot

As of this document update:

- package tests are green across worker, CLI, agent-endpoint, and report-ui
- root build is green
- agent-endpoint standalone typecheck is green
- worker standalone typecheck is still red because `Buffer` is referenced in `packages/worker/src/lib/workspace-deployment-runner.ts` while `packages/worker/tsconfig.json` only includes Cloudflare worker types

Treat that worker typecheck failure as known debt, not a new surprise.

## Best entrypoints for common tasks

If you need to answer one of these questions, start in these files:

- How does `nimbus review create --commit` work?
  - `packages/cli/src/app/reviews/create-from-commit.ts`
  - `packages/cli/src/app/reviews/context.ts`
- How does Studio launch or reuse a local runtime?
  - `packages/cli/src/app/reviews/open.ts`
  - `packages/cli/src/app/reviews/session.ts`
- How does Studio Home start a review?
  - `packages/cli/src/app/reviews/studio-create.ts`
  - `packages/cli/src/app/reviews/ui-proxy.ts`
  - `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- Where do review statuses and events come from?
  - `packages/worker/src/api/reviews/query.ts`
  - `packages/worker/src/api/reviews/events-stream.ts`
  - `packages/worker/src/lib/db/reviews/*`
- Where is the main review execution logic?
  - `packages/worker/src/lib/review-runner.ts`
  - `packages/worker/src/lib/review-runner/*`
- Where is hosted auth implemented?
  - `packages/worker/src/lib/auth.ts`
  - `packages/worker/src/api/auth.ts`
- Why does the UI know about policy states and event streaming?
  - `packages/report-ui/src/lib/review.ts`
  - `packages/report-ui/src/components/ReportPage.tsx`
  - `packages/report-ui/src/components/ReviewHistoryPage.tsx`

## Documentation map after consolidation

Use the docs as follows:

- `docs/architecture/architecture.md`
  - current architecture and repo mental model
- `docs/modules/*`
  - subsystem deep dives for complicated areas
- `docs/architecture/review-session-pivot.md`
  - active product-direction and implementation handoff for the session-based review redesign
- `docs/architecture/review-studio-experience.md`
  - locked product intent for Review Studio
- `docs/architecture/review-studio-implementation-plan.md`
  - current slice status, shipped work, and next-slice guidance
- `docs/architecture/review-studio-experience-build-plan.md`
  - historical sequencing and guardrails from before slices started landing
- `docs/architecture/adr/*`
  - architecture decision records
- `docs/refactor-baseline.md`
  - historical pre-refactor verification snapshot
- `docs/refactor-audit.md`
  - original refactor rationale and target package direction
- `docs/refactor-audit-phase-5.md`
  - current refactor handoff for readability cleanup

## Bottom line

Nimbus is currently best understood as:

- a local CLI and Studio control plane
- a Cloudflare worker that owns durable lifecycle state and execution
- a browser UI that is mid-transition from report viewer to full Studio shell
- a separate agent endpoint that constrains model-backed behavior

If you keep that split in mind, most of the repo becomes easier to navigate.
