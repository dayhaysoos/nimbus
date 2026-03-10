# Phase 7 Cloudflare Contract Test

Use this script to validate the real-provider API contract against a staging worker.

## One-time staging setup

1. Authenticate Wrangler (recommended: OAuth login for full account access):

```bash
pnpm --filter @dayhaysoos/nimbus-worker exec wrangler login
```

2. Set the runtime provider token used by Nimbus worker calls to Cloudflare APIs:

```bash
printf "%s" "$CLOUDFLARE_API_TOKEN" | pnpm --filter @dayhaysoos/nimbus-worker exec wrangler secret put CF_API_TOKEN
```

3. Deploy worker with real provider vars enabled:

```bash
pnpm --filter @dayhaysoos/nimbus-worker exec wrangler deploy \
  --var WORKSPACE_DEPLOY_ENABLED:true \
  --var WORKSPACE_DEPLOY_PROVIDER:cloudflare_workers_assets \
  --var WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED:true \
  --var CF_ACCOUNT_ID:<cloudflare-account-id> \
  --var WORKSPACE_DEPLOY_PROJECT_NAME:<worker-script-name> \
  --var WORKSPACE_DEPLOY_PREVIEW_DOMAIN:<preview-base-domain>
```

Notes:
- `WORKSPACE_DEPLOY_PROJECT_NAME` should be your Worker script name (for example `nimbus-worker`).
- `WORKSPACE_DEPLOY_PREVIEW_DOMAIN` should be the wildcard route base domain (for example `getnimbus.dev` for `*.getnimbus.dev/*`).
- If API-token deploy fails on containers endpoints, switch to `wrangler login` OAuth for deploys.

## Required env
- `NIMBUS_WORKER_URL`
- `NIMBUS_WORKSPACE_ID`

## Create a workspace ID

If you do not already have a workspace ID, create one:

```bash
NIMBUS_WORKER_URL="https://<your-worker>.workers.dev" \
pnpm cli -- workspace create HEAD --project-root packages/worker
```

Copy `Workspace ready: ws_...` into `NIMBUS_WORKSPACE_ID`.

## Optional env
- `NIMBUS_OUTPUT_DIR` (default: `dist`)
- `NIMBUS_EXPECT_TERMINAL_STATUS` (default: `succeeded`)
- `NIMBUS_POLL_INTERVAL_MS` (default: `1500`, must be `>= 100`)
- `NIMBUS_MAX_POLLS` (default: `80`, must be `>= 1`)

## Run
```bash
pnpm run test:cloudflare-contract
```

Example:

```bash
NIMBUS_WORKER_URL="https://<your-worker>.workers.dev" \
NIMBUS_WORKSPACE_ID="ws_abc12345" \
NIMBUS_OUTPUT_DIR="dist" \
NIMBUS_EXPECT_TERMINAL_STATUS="failed" \
pnpm run test:cloudflare-contract
```

## What this checks
1. `GET /api/system/deploy-readiness` returns a valid checks payload.
2. `POST /deploy/preflight` without `deploy.outputDir` fails with `provider_invalid_output_dir`.
3. `POST /deploy/preflight` with provider/outputDir has no failed checks.
4. `POST /deploy` creates a deployment (`202` or `200`) and returns `deployment.id`.
5. Repeating `POST /deploy` with the same idempotency key returns `200` and the same deployment id.
6. `GET /deployments/:id` reaches terminal status within polling bounds.

## Notes
- This is a staging contract test. Run it against a non-production workspace.
- If your staging project intentionally fails deploys, set `NIMBUS_EXPECT_TERMINAL_STATUS=failed`.
- For a success-path validation, run against a workspace/project-root that has a valid static output directory and set `NIMBUS_EXPECT_TERMINAL_STATUS=succeeded`.
