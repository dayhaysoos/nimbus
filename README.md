# Nimbus

Nimbus is currently an experiment and active work in progress.

This README is intentionally minimal while the product direction settles.

Entire docs: [docs.entire.io/introduction](https://docs.entire.io/introduction)

## Current Focus

Nimbus currently supports a cloud review/deploy workflow built around immutable source snapshots:

- Resolve an Entire checkpoint (or commit) to source
- Create a workspace from that snapshot
- Run deploy validation and deployment inside Cloudflare Sandbox
- Persist replayable deploy/review lifecycle state in D1
- Generate non-mutating deployment-backed review reports

## What Works Today

- Checkpoint/commit-backed workspace creation
- Queue-backed workspace task and workspace deploy processing
- Deploy preflight with toolchain / git baseline / secret scan checks
- Deployment lifecycle tracking with replayable events
- Non-mutating review lifecycle with persisted reports and live SSE events
- Minimal report viewer UI (`/reports/:reviewId`) with copy/download workflows
- CLI flows for:
  - `workspace create`
  - `workspace show`
  - `workspace deploy`
  - `review create`
  - `review events`
  - `review show`
  - `review export`

Entire checkpoint notes:

- Checkpoint IDs from commit trailers (for example `checkpoint:be1b10a00b44`) resolve and run.
- The worker executes install/build/test/lint in Cloudflare Sandbox for that checkpoint source.

## Known Limits (Expected Right Now)

- Review quality still depends heavily on the external agent/provider output
- `workspace_deployment` is the only review target in this slice
- Simulated deploy provider returns a synthetic deployed URL unless real provider mode is enabled
- `workspace create HEAD` uses committed `HEAD`, not uncommitted local changes
- Report UI is single-report only (no report index/history view yet)
- Report UI V1 has no auth/SSO (reviewId-access)

## Quick Start (Dev)

From repo root:

```bash
nvm use
source ~/.bash_profile
pnpm install
```

Set up infra (safe to re-run):

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

## Quick Start (Cloud Flow)

Run this from repo root to exercise the deployed worker + cloud sandbox flow:

```bash
pnpm --filter @dayhaysoos/nimbus dev workspace create HEAD
pnpm --filter @dayhaysoos/nimbus dev workspace show <workspace-id>
pnpm --filter @dayhaysoos/nimbus dev workspace deploy <workspace-id> --no-tests --no-build
pnpm --filter @dayhaysoos/nimbus dev review create --workspace <workspace-id> --deployment <deployment-id>
pnpm --filter @dayhaysoos/nimbus dev review events <review-id>
pnpm --filter @dayhaysoos/nimbus dev review show <review-id>
pnpm --filter @dayhaysoos/nimbus dev review export <review-id> --format markdown --out /tmp/review.md
```

Notes:

- The CLI runs locally; workspace/deploy/review execution happens in the cloud worker + sandbox.
- If deploy preflight fails because validation tooling is missing in the sandbox, use `--no-tests --no-build` for the manual flow.
- If deploy preflight reports a missing git baseline, retry with `--auto-fix` or reset/recreate the workspace.

## Quick Start (Report UI V1)

Start worker + UI locally from repo root:

```bash
pnpm dev
pnpm dev:report-ui
```

Then open:

```text
http://localhost:5173/reports/<review-id>
```

Local API routing defaults:

- Vite proxies `/api/*` to `http://127.0.0.1:8787` by default.
- Override proxy target with `NIMBUS_API_PROXY_TARGET`.
- Or set `VITE_NIMBUS_API_BASE_URL` to call a hosted worker directly.

Hosted worker example:

```bash
VITE_NIMBUS_API_BASE_URL="https://<your-worker>.workers.dev" pnpm dev:report-ui
```

Report UI V1 includes:

- Summary header (recommendation, risk, findings count, status, timestamps)
- Findings cards with per-finding copy and fix-prompt copy
- Rendered markdown summary (sanitized)
- Raw JSON section (collapsible)
- Copy/download actions for full markdown and full JSON

Create and watch a live checkpoint job:

```bash
pnpm cli -- deploy checkpoint checkpoint:be1b10a00b44 --project-root packages/worker --no-dry-run
pnpm cli -- watch <job_id>
```

You can also target any commit-ish:

```bash
pnpm cli -- deploy checkpoint HEAD --project-root packages/worker --no-dry-run
```

## Common Commands

```bash
# Run worker tests
pnpm --filter @dayhaysoos/nimbus-worker test

# Run CLI tests
pnpm --filter @dayhaysoos/nimbus test

# Run worker locally
pnpm dev

# Run report UI locally
pnpm dev:report-ui

# Run report UI tests
pnpm test:report-ui

# Build report UI
pnpm build:report-ui

# Deploy latest worker
pnpm run deploy

# Set up worker infra
pnpm run setup:worker
```

## CLI Surface (Current)

```bash
nimbus list
nimbus watch <job-id>
nimbus deploy checkpoint <checkpoint-id-or-commit-ish>
nimbus workspace create <checkpoint-id-or-commit-ish>
nimbus workspace show <workspace-id>
nimbus workspace deploy <workspace-id>
nimbus review create --workspace <workspace-id> --deployment <deployment-id>
nimbus review events <review-id>
nimbus review show <review-id>
nimbus review export <review-id> --format markdown --out <path>
```

Important checkpoint flags:

- `--project-root <path>`: required for many monorepos
- `--no-dry-run`: actually creates/queues a live job
- `--no-tests`, `--no-lint`: skip validation steps in metadata
- `--env-file`, `--env KEY=VALUE`: pass environment inputs for preflight

Important workspace/review flags:

- `workspace deploy --auto-fix`: allow safe git baseline rehydrate remediation
- `workspace deploy --no-tests --no-build`: skip validation steps during manual cloud smoke flows
- `review create --severity-threshold <level>`: limit persisted findings by severity
- `review create --max-findings <n>`: cap persisted findings
- `review create --no-provenance`: suppress provenance in final report output
- `review create --no-validation-evidence`: suppress deploy/validation evidence in final report output

## Notes

- Node 20+ is required.
- Nimbus currently targets self-hosted worker usage.
- If you hit `404` on `/api/checkpoint/jobs`, deploy the latest worker code.
- If you hit review/deploy API shape mismatches, redeploy the latest worker and re-run migrations.

## License

MIT
