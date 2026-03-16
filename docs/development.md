# Nimbus Development

This doc contains dev and self-hosting workflow details moved out of the root README.

## Local setup

From repo root:

```bash
nvm use
pnpm install
```

Set up worker infra (safe to re-run):

```bash
pnpm run setup:worker
```

Deploy worker:

```bash
pnpm run deploy
```

Point CLI to your worker URL:

```bash
export NIMBUS_WORKER_URL="https://<your-worker>.workers.dev"
```

## Review runtime requirements

Review create/readiness requires all of:

- `REVIEWS_QUEUE` binding
- `ReviewRunner` Durable Object binding + migration
- `REVIEW_CONTEXT_GITHUB_TOKEN` configured on the worker

Quick check:

```bash
curl -s "https://<your-worker>.workers.dev/api/system/review-readiness"
```

Expected checks include:

- `queue_binding_reviews`
- `durable_object_binding_review_runner`
- `review_context_github_token_configured`

## Cloud flow smoke commands

```bash
pnpm --filter @dayhaysoos/nimbus dev workspace create HEAD
pnpm --filter @dayhaysoos/nimbus dev workspace show <workspace-id>
pnpm --filter @dayhaysoos/nimbus dev workspace deploy <workspace-id> --no-tests --no-build
pnpm --filter @dayhaysoos/nimbus dev review create --workspace <workspace-id> --deployment <deployment-id>
pnpm --filter @dayhaysoos/nimbus dev review create --commit HEAD
pnpm --filter @dayhaysoos/nimbus dev review events <review-id>
pnpm --filter @dayhaysoos/nimbus dev review show <review-id>
pnpm --filter @dayhaysoos/nimbus dev review export <review-id> --format markdown --out /tmp/review.md
```

Notes:

- CLI runs locally; workspace/deploy/review execution runs in worker + sandbox.
- Review execution path is queue -> `ReviewRunner` Durable Object -> agent endpoint.
- If deploy preflight fails for missing tooling, use `--no-tests --no-build` for smoke flow.

## Report UI local workflow

Start worker + UI:

```bash
pnpm dev
pnpm dev:report-ui
```

Open:

```text
http://localhost:5173/reports/<review-id>
```

API routing defaults:

- Vite proxies `/api/*` to `http://127.0.0.1:8787`
- Override with `NIMBUS_API_PROXY_TARGET`
- Or set `VITE_NIMBUS_API_BASE_URL` for hosted worker

Example:

```bash
VITE_NIMBUS_API_BASE_URL="https://<your-worker>.workers.dev" pnpm dev:report-ui
```

## Common development commands

```bash
pnpm --filter @dayhaysoos/nimbus-worker test
pnpm --filter @dayhaysoos/nimbus test
pnpm dev
pnpm dev:report-ui
pnpm test:report-ui
pnpm build:report-ui
pnpm run deploy
pnpm run setup:worker
```

## CLI surface (current)

```bash
nimbus list
nimbus watch <job-id>
nimbus deploy checkpoint <checkpoint-id-or-commit-ish>
nimbus workspace create <checkpoint-id-or-commit-ish>
nimbus workspace show <workspace-id>
nimbus workspace deploy <workspace-id>
nimbus review create --commit [commit-ish]
nimbus review create --workspace <workspace-id> --deployment <deployment-id>
nimbus review preflight [commit-ish]
nimbus review events <review-id>
nimbus review show <review-id>
nimbus review export <review-id> --format markdown --out <path>
nimbus admin provision-key --label "Beta User Key"
```
