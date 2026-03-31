# Architecture Overview

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe the top-level architecture of Nimbus so a new engineer can understand:

- what each package is responsible for
- how requests and jobs move through the system
- where important runtime boundaries exist
- which areas are stable versus under refactor

## Package Boundaries

### `packages/cli`

- Responsibility: user-facing command-line entrypoint for checkpoint deploys, workspace operations, review flows, auth exchange, repo registration, and local report UI serving.
- Main entrypoints:
  - `packages/cli/src/index.ts`
  - review flows in `packages/cli/src/commands/review/`
  - workspace flows in `packages/cli/src/commands/workspace/`
- Important internal boundaries:
  - command parsing and dispatch in `src/index.ts`
  - local git / Entire checkpoint resolution in `src/lib/checkpoint/*` and `src/lib/entire/*`
  - worker HTTP client in `src/lib/api.ts`
  - orchestration-heavy flows in `src/commands/review/create.ts`, `src/commands/review/open.ts`, and `src/commands/workspace/deploy.ts`
- Notes for future refactors:
  - `src/index.ts` should become a thinner entrypoint
  - the worker API client should be split into domain-specific clients
  - multi-step flows should move out of command handlers into app-level services

### `packages/worker`

- Responsibility: primary backend for the product. Owns HTTP APIs, queue consumers, durable object handoff, persistence, review lifecycle management, workspace lifecycle management, deployment orchestration, hosted auth exchange, and repo registration.
- Main entrypoints:
  - `packages/worker/src/index.ts`
  - route handlers in `packages/worker/src/api/*`
  - queue processors in `packages/worker/src/lib/*runner*.ts`, `review-dispatch.ts`, and related queue files
  - durable object in `packages/worker/src/review-runner-do.ts`
- Important internal boundaries:
  - transport is centralized in `src/index.ts`, but route handlers still own substantial workflow logic
  - persistence is heavily centralized in `src/lib/db.ts`
  - review execution is centered in `src/lib/review-runner.ts`
  - workspace behavior is concentrated in `src/api/workspaces.ts` and deployment/task runners
- Notes for future refactors:
  - separate routing from application services
  - break `db.ts` into domain repositories
  - isolate provider integrations and sandbox operations
  - make queue and retry orchestration more explicit in service-level modules

### `packages/report-ui`

- Responsibility: browser UI for review history, branch review browsing, policy approval, and report viewing.
- Main entrypoints:
  - `packages/report-ui/src/App.tsx`
  - `ReviewHistoryPage.tsx`
  - `BranchReviewsPage.tsx`
  - `PolicyPage.tsx`
  - `ReportPage.tsx`
- Important internal boundaries:
  - routing is defined in `src/App.tsx`
  - request parsing and response normalization live in `src/lib/review.ts`
  - feature pages currently combine data loading, polling, state derivation, and presentation
- Notes for future refactors:
  - split feature containers from presentational components
  - move parsing and formatting logic out of oversized pages, especially `ReportPage.tsx`

### `packages/agent-endpoint`

- Responsibility: separate inference-oriented endpoint that validates structured review output and supports a smaller action-based agent loop.
- Main entrypoints:
  - `packages/agent-endpoint/src/index.ts`
  - `packages/agent-endpoint/src/lib/agent.ts`
- Important internal boundaries:
  - transport is owned by `src/index.ts`
  - validation, parsing, and review-output rules are concentrated in `src/lib/agent.ts`
- Notes for future refactors:
  - separate review-specific logic from workspace-task agent behavior
  - isolate contracts from endpoint handling

## Cross-Package Relationships

- CLI -> Worker: the CLI is the main operator client. It resolves local git/checkpoint context, then calls worker APIs for workspace creation, deployment, review creation, auth exchange, repo registration, and status polling.
- Worker -> Agent Endpoint: the worker is configured with an `AGENT_ENDPOINT` service binding and delegates some model-backed behavior through that endpoint rather than embedding all inference transport directly in the main worker.
- Report UI -> Worker: the React app talks directly to worker review APIs for listing reviews, fetching a report, polling lifecycle state, and approving a derived policy.
- Worker -> Cloudflare runtime resources: the worker depends on D1 for persistence, R2 for source bundles, KV for JWKS caching, queues for checkpoint/deploy/review/task work dispatch, a sandbox durable object binding, and a review-runner durable object binding.

## Runtime Boundaries

- HTTP/API boundary: all public backend entrypoints route through `packages/worker/src/index.ts`, which authenticates the request, enforces request-size limits, and dispatches to handler functions.
- Queue boundary: checkpoint jobs, workspace tasks, workspace deployments, and reviews are queued and later processed by worker-side consumers declared in `packages/worker/wrangler.toml`.
- Durable Object boundary: review execution is handed off through the `ReviewRunner` durable object to avoid dropping queued reviews and to serialize execution per review ID.
- Persistence boundary: D1 is the system of record for jobs, workspaces, deployments, reviews, events, runtime flags, and related metadata, mostly through `packages/worker/src/lib/db.ts`.
- Sandbox/provider boundary: workspace file hydration and command execution happen through `@cloudflare/sandbox`; deployment and external service calls are handled through provider-specific code inside worker runners and API modules.
- UI/client boundary: both the CLI and the report UI are thin clients relative to backend state ownership. The worker owns canonical status and event history.

## Critical Invariants

- Review target support is currently limited to `workspace_deployment` and review mode is currently limited to `report_only`.
- Workspace access, review access, and hosted account scoping are enforced at the worker boundary before resource-specific handlers continue.
- Queued background work is persisted in backend state first, then surfaced to clients via polling or event streams.

## Known Architectural Pain Points

- `packages/worker/src/lib/db.ts` centralizes too many unrelated persistence concerns and hides domain boundaries.
- `packages/worker/src/api/workspaces.ts` and `packages/worker/src/api/reviews.ts` both combine transport, orchestration, validation, and integration behavior in very large files.
- `packages/cli/src/index.ts`, `packages/cli/src/lib/api.ts`, and `packages/report-ui/src/components/ReportPage.tsx` are carrying too much flow logic for their current roles.

## Target Direction

- Routes and command entrypoints should become thin adapters around explicit service modules.
- Persistence, provider integrations, and domain workflows should be separated into readable subtrees.
- Tests and docs should mirror the cleaned-up architecture rather than current oversized files.

## Source References

- `packages/cli/src/index.ts`
- `packages/cli/src/lib/api.ts`
- `packages/worker/src/index.ts`
- `packages/worker/src/lib/db.ts`
- `packages/worker/wrangler.toml`
- `packages/worker/src/review-runner-do.ts`
- `packages/report-ui/src/App.tsx`
- `packages/agent-endpoint/src/index.ts`
- `packages/agent-endpoint/src/lib/agent.ts`
