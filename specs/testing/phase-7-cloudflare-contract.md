# Phase 7 Cloudflare Contract Test

Use this script to validate the real-provider API contract against a staging worker.

## Required env
- `NIMBUS_WORKER_URL`
- `NIMBUS_WORKSPACE_ID`

## Optional env
- `NIMBUS_OUTPUT_DIR` (default: `dist`)
- `NIMBUS_EXPECT_TERMINAL_STATUS` (default: `succeeded`)
- `NIMBUS_POLL_INTERVAL_MS` (default: `1500`, must be `>= 100`)
- `NIMBUS_MAX_POLLS` (default: `80`, must be `>= 1`)

## Run
```bash
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
