# Nimbus

Nimbus runs checkpoint-aware cloud review workflows so you can review code at a known Entire commit state with one command.

## Quick Start (Hosted Nimbus)

Prereqs:

- Node 20+
- A repo tracked with Entire checkpoints
- Nimbus API key (provided by Nimbus admin)
- GitHub PAT for your repo (used as `REVIEW_CONTEXT_GITHUB_TOKEN`)

Install:

```bash
npm install -g @dayhaysoos/nimbus
```

Set local environment variables:

```bash
export NIMBUS_WORKER_URL="https://nimbus-worker.ndejesus1227.workers.dev"
export NIMBUS_API_KEY="nmb_live_..."
```

### Onboard a New Repository (one-time)

1. Register your repo to your Nimbus account:

```bash
nimbus repo register --repo owner/repo
```

2. Add your GitHub PAT to repository secrets:
   - Secret name: `REVIEW_CONTEXT_GITHUB_TOKEN`
   - Location: Repo Settings -> Secrets and variables -> Actions

3. Add the Nimbus PR workflow file to your repo:
   - `.github/workflows/nimbus-pr-review.yml`

4. Open or update a PR.
   - Nimbus runs automatically.
   - A successful run posts a Nimbus findings comment on the PR.

Notes:

- `NIMBUS_API_KEY` is for local CLI use (for example, `repo register`).
- CI uses short-lived runtime tokens and should not require storing a long-lived Nimbus API key secret.
- Reviews can still run without `REVIEW_CONTEXT_GITHUB_TOKEN`, but co-change context may be unavailable and review quality can drop.

Run your first local review:

```bash
nimbus review create --commit HEAD
```

Want the full walkthrough and troubleshooting? See `docs/getting-started.md`.

## How It Works

Nimbus resolves your commit and Entire checkpoint context, creates an isolated workspace, runs deployment checks in Cloudflare Sandbox, and then creates a non-mutating review report. The CLI streams progress in real-time and returns a report URL when complete. Review output includes findings, severity, and provenance so you can understand both what changed and why the review reached its recommendation.

## Self-hosting

Nimbus supports hosted usage and self-hosted worker deployments. For setup steps, runtime requirements, and local dev workflow, see `docs/development.md`.

## License

MIT
