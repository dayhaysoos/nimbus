# Nimbus

Nimbus is currently an experiment and active work in progress.

This README is intentionally minimal while the product direction settles.

Entire docs: [docs.entire.io/introduction](https://docs.entire.io/introduction)

## Current Focus

The current priority is launching Entire checkpoints in a sandbox execution pipeline:

- Resolve an Entire checkpoint (or commit) to source
- Upload a source bundle to the worker
- Queue a background checkpoint job
- Run install/build/test/lint inside Cloudflare Sandbox
- Persist job status and replayable events

## What Works Today

- `deploy checkpoint` dry-run resolution and preflight
- Live checkpoint job creation with `--no-dry-run`
- Queue-backed worker processing (`CHECKPOINT_JOBS_QUEUE`)
- Deterministic installs with lockfile enforcement
- `watch` polling for queued/running/completed/failed jobs

Entire checkpoint notes:

- Checkpoint IDs from commit trailers (for example `checkpoint:be1b10a00b44`) resolve and run.
- The worker executes install/build/test/lint in Cloudflare Sandbox for that checkpoint source.

## Known Limits (Expected Right Now)

- No persistent preview/deployed URL for checkpoint jobs yet
- Checkpoint live SSE stream output in CLI is not complete yet
- Checkpoint install support is currently for npm/bun lockfiles (pnpm/yarn are rejected)

## Quick Start (Dev)

From repo root:

```bash
nvm use
source ~/.bash_profile
pnpm install
```

Set up infra (safe to re-run):

```bash
pnpm wrangler queues create nimbus-checkpoint-jobs
pnpm wrangler d1 migrations apply nimbus-db --remote
```

Deploy worker:

```bash
pnpm run deploy
```

Point CLI to your worker URL:

```bash
export NIMBUS_WORKER_URL="https://<your-worker>.workers.dev"
```

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
```

## CLI Surface (Current)

```bash
nimbus list
nimbus watch <job-id>
nimbus deploy checkpoint <checkpoint-id-or-commit-ish>
```

Important checkpoint flags:

- `--project-root <path>`: required for many monorepos
- `--no-dry-run`: actually creates/queues a live job
- `--no-tests`, `--no-lint`: skip validation steps in metadata
- `--env-file`, `--env KEY=VALUE`: pass environment inputs for preflight

## Notes

- Node 20+ is required.
- Nimbus currently targets self-hosted worker usage.
- If you hit `404` on `/api/checkpoint/jobs`, deploy the latest worker code.

## License

MIT
