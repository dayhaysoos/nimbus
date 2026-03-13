# Nimbus Report UI V1

Minimal report viewer for Nimbus review runs.

## Local run

1. Install dependencies from repo root:

   ```bash
   pnpm install
   ```

2. Start worker API (in one terminal):

   ```bash
   pnpm dev
   ```

   The report UI dev server proxies `/api` to `http://127.0.0.1:8787` by default.

3. Start report UI (in another terminal):

   ```bash
   pnpm dev:report-ui
   ```

4. Open `http://localhost:5173/reports/<reviewId>`.

If your API runs on a different host, either:

- set `VITE_NIMBUS_API_BASE_URL` for browser requests, or
- set `NIMBUS_API_PROXY_TARGET` for Vite proxying.

Example with hosted worker:

```bash
VITE_NIMBUS_API_BASE_URL="https://nimbus-worker.ndejesus1227.workers.dev" pnpm dev:report-ui
```

## Quick smoke checklist

- Open a known review URL: `/reports/<reviewId>`
- Verify summary header renders recommendation, risk, findings count, status, and timestamps
- Click `Copy full markdown`, `Copy full JSON`, `Copy finding`, and `Copy fix prompt` and confirm toast
- Click `Download markdown` and `Download JSON` and verify files save
- Confirm loading, queued/running, failed/cancelled, and not-found states are readable
