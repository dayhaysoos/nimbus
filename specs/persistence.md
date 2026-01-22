# Slice 1: Persistence

> **Branch:** `persistence`  
> **Estimated Time:** 3-5 days  
> **Theme:** Jobs are stored, trackable, and permanently deployed

---

## Overview

Currently, Nimbus builds are ephemeral - once the CLI disconnects or the sandbox times out, everything is lost. This slice adds persistence so users can:

1. See a list of past jobs
2. Get the status of any job by ID
3. Have permanently deployed sites (Cloudflare Pages)

---

## Current State (Slice 0)

```
CLI → POST /build (SSE stream) → Worker → Claude → Sandbox → Preview URL
                                                              ↓
                                                    (dies when sandbox dies)
```

- No database
- No job history
- Preview URLs are temporary
- Can't check status after CLI disconnects

---

## Target State (Slice 1)

```
CLI → POST /api/jobs → Worker → D1 (create job) → Workflow → Claude → Sandbox → Pages
         ↓                                            ↓
    Returns job_id                              Updates D1 status
         ↓
CLI → GET /api/jobs/:id → D1 → Returns status + deployed URL
```

- Jobs stored in D1 database
- Permanent URLs via Cloudflare Pages
- Can check status anytime
- Job history with `nimbus list`

---

## Features

### 1. D1 Database

Create a Cloudflare D1 database to store jobs.

**Schema:**

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,                    -- e.g., "job_abc123"
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,                    -- e.g., "anthropic/claude-sonnet-4"
    status TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    
    -- Output
    preview_url TEXT,                       -- Sandbox preview (temporary)
    deployed_url TEXT,                      -- Pages URL (permanent)
    
    -- Error info
    error_message TEXT,
    
    -- Basic metrics (expanded in Slice 2)
    file_count INTEGER,
    
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
```

**Setup commands:**

```bash
cd packages/worker

# Create database
npx wrangler d1 create nimbus-db

# Add binding to wrangler.toml (will get database_id from above command)
# [[d1_databases]]
# binding = "DB"
# database_name = "nimbus-db"
# database_id = "<from create command>"

# Run migration
npx wrangler d1 execute nimbus-db --file=./migrations/0001_jobs.sql
```

### 2. New API Endpoints

Replace `POST /build` (SSE) with proper REST endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/jobs` | Create job, return job ID |
| GET | `/api/jobs` | List all jobs |
| GET | `/api/jobs/:id` | Get job status |

**POST /api/jobs**

Request:
```json
{
  "prompt": "Build a landing page",
  "model": "anthropic/claude-sonnet-4"
}
```

Response (202 Accepted):
```json
{
  "jobId": "job_abc123",
  "status": "pending"
}
```

**GET /api/jobs/:id**

Response:
```json
{
  "id": "job_abc123",
  "prompt": "Build a landing page",
  "model": "anthropic/claude-sonnet-4",
  "status": "completed",
  "createdAt": "2025-01-22T04:00:00Z",
  "startedAt": "2025-01-22T04:00:01Z",
  "completedAt": "2025-01-22T04:02:15Z",
  "previewUrl": "https://8080-job-abc123.getnimbus.dev/",
  "deployedUrl": "https://job-abc123.pages.dev/",
  "fileCount": 3
}
```

**GET /api/jobs**

Response:
```json
{
  "jobs": [
    {
      "id": "job_abc123",
      "prompt": "Build a landing page",
      "model": "anthropic/claude-sonnet-4",
      "status": "completed",
      "createdAt": "2025-01-22T04:00:00Z",
      "deployedUrl": "https://job-abc123.pages.dev/"
    }
  ]
}
```

### 3. Cloudflare Pages Deployment

After a successful build, deploy to Cloudflare Pages for a permanent URL.

**Implementation approach:**

Option A: Use Wrangler from inside sandbox
```typescript
// In sandbox after build succeeds
await sandbox.exec(
  `npx wrangler pages deploy ./dist --project-name=${jobId}`,
  {
    env: {
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID
    }
  }
);
```

Option B: Use Cloudflare API directly from worker
```typescript
// Read built files from sandbox, upload via API
const files = await sandbox.readDir('/root/app/dist');
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}` },
    body: createFormData(files)
  }
);
```

**Recommendation:** Start with Option A (simpler), switch to Option B if needed.

**Required secrets:**
```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### 4. CLI Updates

**New command: `nimbus list`**

```bash
$ nimbus list

  ID            Status      Model              Created         URL
  job_abc123    completed   claude-sonnet-4    2 hours ago     https://job-abc123.pages.dev
  job_def456    running     claude-sonnet-4    5 minutes ago   -
  job_ghi789    failed      gpt-4o             1 day ago       -
```

**Updated: `nimbus watch`**

Instead of relying on SSE, poll `GET /api/jobs/:id`:

```typescript
while (status !== 'completed' && status !== 'failed') {
  const job = await fetch(`${WORKER_URL}/api/jobs/${jobId}`);
  displayStatus(job);
  await sleep(2000);  // Poll every 2 seconds
}
```

**New: Show deployed URL at end**

```
┌  @dayhaysoos/nimbus
│
◇  Job created: job_abc123
◇  Generating code...
◇  Building...
◇  Deploying to Pages...
◇  Done!
│
└  Deployed: https://job-abc123.pages.dev/
```

### 5. Background Processing

Currently, the build runs synchronously inside the request handler. For persistence, we need background processing.

**Option A: Keep SSE but also write to D1**

The current SSE approach can stay, just add D1 writes at each step:

```typescript
async function handleBuild(request, env) {
  // Create job in D1
  const jobId = `job_${generateId()}`;
  await env.DB.prepare('INSERT INTO jobs ...').run();
  
  // Existing SSE streaming logic, but also update D1
  sendEvent({ type: 'generating' });
  await env.DB.prepare('UPDATE jobs SET status = "running"...').run();
  
  // ... rest of build ...
  
  await env.DB.prepare('UPDATE jobs SET status = "completed"...').run();
}
```

**Option B: Use Cloudflare Workflows (from spec)**

More robust, but more complex. Deferred to later slice.

**Recommendation:** Start with Option A. It's simpler and the SSE streaming UX is nice. Add Workflows in a future slice when we need multi-variant parallel builds.

---

## File Changes

### New Files

```
packages/worker/
├── migrations/
│   └── 0001_jobs.sql           # Database schema
├── src/
│   ├── api/
│   │   └── jobs.ts             # Job CRUD endpoints
│   └── lib/
│       └── deploy/
│           └── pages.ts        # Pages deployment logic

packages/cli/
├── src/
│   └── commands/
│       └── list.ts             # New list command
```

### Modified Files

```
packages/worker/
├── wrangler.toml               # Add D1 binding
├── src/
│   ├── index.ts                # Update routing
│   ├── types.ts                # Add Env.DB type
│   └── sandbox.ts              # Add Pages deployment step

packages/cli/
├── src/
│   ├── index.ts                # Add list command, update watch
│   └── commands/
│       └── watch.ts            # Switch to polling
```

---

## Task Breakdown

### Day 1: Database Setup
- [ ] Create D1 database
- [ ] Write migration SQL
- [ ] Add D1 binding to wrangler.toml
- [ ] Update Env type in types.ts
- [ ] Test database connection

### Day 2: API Endpoints
- [ ] Create `POST /api/jobs` - creates job, starts build
- [ ] Create `GET /api/jobs/:id` - returns job status
- [ ] Create `GET /api/jobs` - lists all jobs
- [ ] Update existing build logic to write to D1

### Day 3: Pages Deployment
- [ ] Add CLOUDFLARE_API_TOKEN and ACCOUNT_ID secrets
- [ ] Implement Pages deployment after successful build
- [ ] Store deployed_url in D1
- [ ] Test end-to-end deployment

### Day 4: CLI Updates
- [ ] Add `nimbus list` command
- [ ] Update `nimbus watch` to poll API (or keep SSE + show final URL)
- [ ] Show deployed URL at completion
- [ ] Test full flow

### Day 5: Polish & Edge Cases
- [ ] Handle deployment failures gracefully
- [ ] Add error messages to D1
- [ ] Test with failed builds
- [ ] Update README if needed

---

## What's NOT in This Slice

- Multiple models per job (Slice 5)
- Auto-retry on build failures (Slice 3)
- Human escalation (Slice 4)
- Detailed metrics (tokens, cost, duration) (Slice 2)
- Reports (Slice 6)
- GitHub export (Slice 8)
- Cloudflare Workflows (can add later for robustness)
- Job cleanup/TTL (later slice)

---

## Definition of Done

- [ ] Can run `nimbus start "prompt"` and get a job ID
- [ ] Can run `nimbus list` and see past jobs
- [ ] Can run `nimbus watch <jobId>` and see status
- [ ] Completed jobs have a permanent `*.pages.dev` URL
- [ ] Jobs persist across CLI sessions (can check status later)
- [ ] Failed jobs show error message

---

## Open Questions

1. **Keep SSE or switch to pure polling?**
   - SSE gives nice real-time UX but adds complexity
   - Polling is simpler and works with the REST API pattern
   - Recommendation: Keep SSE for now, also write to D1

2. **Pages project naming?**
   - Option: `nimbus-{jobId}` → `nimbus-job-abc123.pages.dev`
   - Option: Just `{jobId}` → `job-abc123.pages.dev`
   - Need to handle naming conflicts

3. **What to do with preview URL?**
   - Keep exposing it during build (useful for debugging)
   - Could remove once Pages deployment succeeds
   - Or keep both URLs in the response

---

## References

- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Cloudflare Pages API](https://developers.cloudflare.com/pages/platform/api/)
- [Full PRD - Section 17.2 Slice 1](../PRD.md) (if you save the full spec)
