# Nimbus

Nimbus runs checkpoint-aware cloud review workflows so you can review code at a known Entire commit state with one command.

## Quick Start (Beta Users)

Prereqs:

- Node 20+
- A repo tracked with Entire checkpoints
- `NIMBUS_API_KEY`

Install:

```bash
npm install -g @dayhaysoos/nimbus
```

Set environment variables:

```bash
export NIMBUS_API_KEY="nmb_live_..."
export OPENROUTER_API_KEY="..."
```

Run your first review:

```bash
nimbus review create --commit HEAD
```

Want the full walkthrough and troubleshooting? See `docs/getting-started.md`.

## How It Works

Nimbus resolves your commit and Entire checkpoint context, creates an isolated workspace, runs deployment checks in Cloudflare Sandbox, and then creates a non-mutating review report. The CLI streams progress in real time and returns a report URL when complete. Review output includes findings, severity, and provenance so you can understand both what changed and why the review reached its recommendation.

## Self-hosting

Nimbus supports hosted usage and self-hosted worker deployments. For setup steps, runtime requirements, and local dev workflow, see `docs/development.md`.

## License

MIT
