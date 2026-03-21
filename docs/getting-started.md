# Nimbus Getting Started (Beta Users)

This guide is for beta users who want the fastest path to useful review output.

## Before you run

Make sure you have:

- Node 20+
- A repository with committed code at `HEAD`
- Entire active in your repo workflow
- `NIMBUS_API_KEY`
- `OPENROUTER_API_KEY`
- `REVIEW_CONTEXT_GITHUB_TOKEN` (recommended when local co-change context is unavailable)

Install CLI globally:

```bash
npm install -g @dayhaysoos/nimbus
```

Set env vars:

```bash
export NIMBUS_API_KEY="nmb_live_..."
export OPENROUTER_API_KEY="..."
export REVIEW_CONTEXT_GITHUB_TOKEN="ghp_..."
```

Run review:

```bash
nimbus review create --commit HEAD
```

## What to expect from output

The command runs a staged flow:

1. Resolve commit/checkpoint context
2. Validate Entire session metadata
3. Create workspace
4. Deploy workspace snapshot
5. Create and stream review events
6. Print a final report URL

You will see identifiers like workspace ID, deployment ID, and review ID. These are useful for follow-up commands like `nimbus review show <review-id>` and `nimbus review events <review-id>`.

## How to interpret findings

Focus on three things first:

- Recommendation (`approve`, `comment`, or `request_changes`)
- Severity distribution
- High-confidence findings with concrete file locations

Treat findings as triage input, not automatic truth. Validate suggested fixes against your repo constraints and release risk.

## Practical next steps

After a run:

1. Open the report URL and review high/critical findings first.
2. Apply fixes in your branch, then rerun `nimbus review create --commit HEAD` on the updated commit.
3. Export a shareable report artifact if needed:

```bash
nimbus review export <review-id> --format markdown --out ./review.md
```

4. If review creation fails early, run:

```bash
nimbus review preflight HEAD
```

This helps catch checkpoint/session-context issues and token readiness problems before queueing a full review.

## API behavior note

When using the worker API directly (`POST /api/reviews`) without CLI preflight, review creation can return queued/accepted even if GitHub co-change auth is missing. In that case, the run may fail later with `review_context_github_token_missing` unless local co-change provenance is available.
