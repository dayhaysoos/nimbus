# Phase 7: Real Deployment Provider

## Objective
Replace simulated deployment output with a real provider integration that publishes build artifacts and returns a live, reachable URL.

## Why this phase exists
Phase 5-6 validated deployment orchestration and safety policies, but deployment still uses `provider=simulated`. The core user promise requires a real hosted preview/runtime target.

## Product decisions (proposed final)
1. **Provider interface first:** keep a provider abstraction and implement one concrete adapter first (Cloudflare-focused path).
2. **Safe fallback:** keep `simulated` provider available behind explicit request for local/testing flows.
3. **Artifact ownership:** deployment input stays workspace snapshot bundle; provider adapter handles publish/activate.
4. **Deterministic status model:** map provider-native states to Nimbus statuses (`queued|running|succeeded|failed|cancelled`).
5. **Provider target (v1):** use Cloudflare Workers Assets as the first real deployment target.
6. **Runtime scope (v1):** static builds only; reject SSR/server deployment attempts with clear nextAction guidance.
7. **Build location:** build in sandbox, publish build output only (no provider-side build).
8. **Artifact contract:** require explicit `deploy.outputDir`; no framework output directory auto-detection in v1.
9. **Project mapping:** one shared provider project with deterministic route mapping per deployment.
10. **URL policy:** return immutable per-deploy preview URL (`dep-<deploymentId>.<previewDomain>`).
11. **Credential model:** use Cloudflare account token + account id via worker env/secrets.
12. **Cancel semantics:** best-effort cancel against provider; continue polling to terminal state when provider cannot cancel.
13. **Rollout safety:** real provider path stays feature-flagged off by default until soak criteria pass.
14. **Credential precheck:** add provider credential/scope self-check and fail early with actionable nextAction.
15. **Retention:** provider metadata/events follow existing deployment retention windows.

## In scope
- Provider adapter contract in worker runtime.
- One real provider implementation.
- Provider-specific deployment ID + URL persistence.
- Polling and terminal status mapping.
- Provider failure normalization to actionable error codes.

## Out of scope
- Multi-provider routing policy UI.
- Cross-provider failover.
- Progressive traffic shaping.

## Deliverables

### D1. Provider adapter interface
- `WorkspaceDeployProvider` contract:
  - `createDeployment(input)`
  - `getDeploymentStatus(providerDeploymentId)`
  - `cancelDeployment(providerDeploymentId)`

### D2. Real provider implementation
- Build/publish flow from workspace deployment bundle.
- Resolve final live URL and metadata.
- Enforce `deploy.outputDir` contract for static asset publish input.
- Implement deterministic preview URL mapping per deployment.

### D3. API and CLI integration
- Allow `provider` values beyond `simulated`.
- Keep default behavior explicit and documented.
- CLI output distinguishes live URL vs simulated URL.
- Add explicit validation error when `deploy.outputDir` is missing/invalid.

### D4. Error taxonomy
- Add provider errors:
  - `provider_auth_failed`
  - `provider_rate_limited`
  - `provider_project_not_found`
  - `provider_deploy_failed`
  - `provider_invalid_output_dir`
  - `provider_scope_missing`

### D5. Cloudflare provider configuration contract
- Required env/secrets (worker):
  - `WORKSPACE_DEPLOY_PROVIDER=cloudflare_workers_assets`
  - `CF_ACCOUNT_ID`
  - `CF_API_TOKEN`
  - `WORKSPACE_DEPLOY_PREVIEW_DOMAIN`
  - `WORKSPACE_DEPLOY_PROJECT_NAME`
- Optional safety flag:
  - `WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED=false` by default

## Acceptance criteria
- A successful workspace deploy can produce a reachable live URL.
- Provider deployment ID and URL are persisted and queryable.
- Failed provider deploys include normalized `nextAction` guidance.
- Static deploy attempts without `deploy.outputDir` fail with `provider_invalid_output_dir`.
- Credential/scope precheck catches invalid/missing token setup before first provider deployment attempt.
- Successful deploy URL follows `dep-<deploymentId>.<previewDomain>` pattern.

## Implementation checklist
1. Add provider adapter abstraction in worker.
2. Add real provider credentials/config validation.
3. Implement create/status/cancel mapping.
4. Wire adapter into deployment runner.
5. Add integration tests for success/failure/cancel paths.
6. Update CLI/docs with real-provider behavior.
7. Add `deploy.outputDir` schema validation in deploy request/preflight path.
8. Add provider credential scope self-check endpoint/use during preflight.
9. Add deterministic preview URL builder and conflict-safe route naming.
