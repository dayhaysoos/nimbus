# Phase 6 Deploy Smoke

Use this runbook to validate toolchain parity, preflight auto-fix, and deploy CLI ergonomics.

## Preconditions
- `NIMBUS_WORKER_URL` points to the target worker.
- Workspace exists and is `ready`.

## Smoke path
1. Run preflight-only with safe remediations enabled:

```bash
nimbus workspace deploy <workspace-id> --preflight-only --auto-fix
```

Expected:
- preflight check list is printed,
- toolchain summary is printed,
- remediation summary is printed when applied.

2. Run deploy with validation disabled for a fast control path:

```bash
nimbus workspace deploy <workspace-id> --no-tests --no-build --auto-fix --poll-interval-ms 1000
```

Expected:
- deployment queues,
- status polling updates print every ~1s,
- terminal success prints deployed URL,
- terminal failure prints actionable `nextAction` when available.
