# Module: Workspace Deployment

## Status

- State: current-state baseline
- Owner: `packages/worker/src/api/workspace-deployments.ts` and `packages/worker/src/lib/workspace-deployment-runner.ts`

## Purpose

Validate whether a workspace is deployable, create a deployment record, execute deployment work through a provider, and reconcile final state for success, failure, retry, or cancellation.

## Boundaries

- Inputs:
  - workspace ID
  - deployment request payload
  - runtime flags and provider configuration
- Outputs:
  - preflight result
  - deployment record and summary
  - deployment events
- External dependencies:
  - D1
  - workspace sandbox
  - deployment provider integration
  - queue or inline execution context
- Things this module must not own:
  - CLI presentation
  - route registration
  - report UI polling behavior

## Important Concepts

- Preflight: a readiness pass that checks workspace state, baseline health, toolchain detectability, secret risk, and provider requirements.
- Provider precheck: an additional provider-specific gate that can fail a deployment before execution begins.
- Baseline readiness: deployment assumes a recoverable git baseline in the workspace sandbox.
- Cooperative cancellation: queued deployments can be cancelled immediately; running deployments reconcile through provider-aware state checks.

## Core Flow

1. Preflight evaluates workspace readiness and optional auto-fix remediations.
2. Create-deployment persists the request with idempotency protection.
3. Execution is dispatched by queue or inline worker context.
4. The runner claims the deployment, performs install/build/test/provider steps, and persists terminal state.

## Invariants

- A deployment must be persisted before background execution begins.
- Deployment events are part of the public observability contract for CLI polling and future UI surfaces.
- Provider-specific output directory validation must remain enforced for `cloudflare_workers_assets`.

## Failure Modes

- Preflight returns a non-ok result because workspace or provider readiness checks fail.
- Provider precheck fails before execution starts.
- Running deployment becomes stale, hits transient provider failure, or needs cancellation reconciliation.

## Source References

- `packages/worker/src/api/workspace-deployments.ts`
- `packages/worker/src/lib/workspace-deployment-runner.ts`
- `packages/worker/src/lib/workspace-deploy-provider.ts`
- `packages/cli/src/commands/workspace/deploy.ts`

## Notes For Future Refactors

- Split preflight, execution, cancellation, and provider reconciliation into clearer service-level modules.
- Separate generic workspace preparation logic from provider-specific publish behavior.
