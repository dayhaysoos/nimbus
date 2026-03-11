# Phase 7 Real Provider Smoke

Use this runbook to validate the Cloudflare Workers Assets provider path end-to-end.

## Preconditions
- `NIMBUS_WORKER_URL` points to the target worker.
- Workspace exists and is `ready`.
- Worker env/secrets are configured:
  - `WORKSPACE_DEPLOY_ENABLED=true`
  - `WORKSPACE_DEPLOY_PROVIDER=cloudflare_workers_assets`
  - `WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED=true`
  - `WORKSPACE_DEPLOY_PREVIEW_DOMAIN`
  - `WORKSPACE_DEPLOY_PROJECT_NAME`
  - `CF_ACCOUNT_ID`
  - `CF_API_TOKEN`

## Bootstrap
```bash
pnpm run setup:worker
nimbus doctor
```

Expected:
- doctor shows provider checks as `ok`.

## Smoke path
1. Provider preflight with explicit output dir:

```bash
nimbus workspace deploy <workspace-id> --provider cloudflare_workers_assets --output-dir dist --preflight-only
```

Expected:
- preflight prints `provider_output_dir` check,
- provider credential/scope checks pass,
- preflight succeeds.

2. Real deploy:

```bash
nimbus workspace deploy <workspace-id> --provider cloudflare_workers_assets --output-dir dist --poll-interval-ms 1000
```

Expected:
- deployment queues and transitions `queued -> running -> succeeded`,
- terminal output prints `Live URL: https://dep-<deploymentId>.<previewDomain>`,
- `providerDeploymentId` is present in deployment status payload.

## Negative checks
1. Missing output dir should fail fast:

```bash
nimbus workspace deploy <workspace-id> --provider cloudflare_workers_assets --preflight-only
```

Expected:
- preflight fails with `provider_invalid_output_dir` and a clear next action.

2. Invalid provider token/scope:
- Temporarily set bad `CF_API_TOKEN` or remove required scopes.

Expected:
- preflight fails with `provider_auth_failed` or `provider_scope_missing` before deployment is queued.
