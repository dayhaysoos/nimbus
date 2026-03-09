# Phase 5 Deploy Smoke Test

## Prerequisites
- Worker migrations applied locally.
- Worker running with deploy flag enabled:
  - `npx wrangler dev --var WORKSPACE_DEPLOY_ENABLED:true`
- `NIMBUS_WORKER_URL` set to local worker URL.

## Fast path with CLI wrapper
1. Create or reuse a ready workspace.
2. Run:
   - `nimbus workspace deploy <workspace-id>`
3. Expected:
   - Preflight passes.
   - Deployment transitions queued/running -> succeeded.
   - CLI prints deployed URL.

## API preflight only
```bash
curl -sS -X POST "$NIMBUS_WORKER_URL/api/workspaces/<workspace-id>/deploy/preflight" \
  -H "Content-Type: application/json" \
  -d '{"validation":{"runBuildIfPresent":true,"runTestsIfPresent":true}}'
```

Expected:
- `preflight.ok=true` for deployable workspace.
- `preflight.ok=false` with check details and `nextAction` for failures.

## Known failure codes and guidance
- `validation_tool_missing`:
  - Validation command requires tooling missing in sandbox runtime.
  - Action: disable validation or install tooling in sandbox image.
- `baseline_missing` / `baseline_rehydrate_failed`:
  - Workspace baseline is missing or could not be rebuilt.
  - Action: reset workspace and retry.
- `potential_secrets_detected`:
  - Sensitive files detected in source tree.
  - Action: remove/rename sensitive files before deploy.

## Manual API deploy + poll
```bash
IDEMP="deploy-smoke-$(date +%s)"
curl -sS -X POST "$NIMBUS_WORKER_URL/api/workspaces/<workspace-id>/deploy" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMP" \
  -d '{"provider":"simulated","validation":{"runBuildIfPresent":false,"runTestsIfPresent":false},"retry":{"maxRetries":2},"rollbackOnFailure":true,"provenance":{"trigger":"manual"}}'
```

Then poll deployment id:
```bash
curl -sS "$NIMBUS_WORKER_URL/api/workspaces/<workspace-id>/deployments/<deployment-id>"
```

And events:
```bash
curl -sS "$NIMBUS_WORKER_URL/api/workspaces/<workspace-id>/deployments/<deployment-id>/events?from=0&limit=200"
```
