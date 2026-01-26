# Nimbus

An open-source CLI that generates and deploys websites using AI. Give it a prompt, get back a permanent URL.

```bash
export NIMBUS_WORKER_URL=https://your-worker.com
npx @dayhaysoos/nimbus start "Build a coffee shop landing page"
```

> **Note**: Nimbus requires a self-hosted worker. See the [Self-Hosting Guide](#self-hosting-guide) below to set up your own instance in ~15 minutes.

**Built with:**
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless API
- [Cloudflare Containers/Sandbox SDK](https://developers.cloudflare.com/sandbox/) - Isolated code execution
- [Cloudflare D1](https://developers.cloudflare.com/d1/) - Job persistence
- [Cloudflare R2](https://developers.cloudflare.com/r2/) - Build/deploy logs
- [Claude](https://anthropic.com/claude) via [OpenRouter](https://openrouter.ai/) - Code generation
- [clack](https://github.com/bombshell-dev/clack) - Beautiful CLI prompts

## Framework Support

- **Next.js SSR** on Cloudflare Workers via OpenNext
- **Astro SSR** on Cloudflare Workers
- **Static sites** (HTML/CSS/JS) when no framework is specified

## How It Works

```
┌─────────┐     ┌──────────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI   │────▶│ Cloudflare Worker│────▶│   Claude    │────▶│   Sandbox   │
│         │     │   (POST /api/jobs)│    │ (OpenRouter)│     │ (Container) │
└─────────┘     └──────────────────┘     └─────────────┘     └─────────────┘
                        │                                           │
                        ▼                                           ▼
               ┌────────────────┐                        ┌─────────────────────────┐
               │   D1 Database  │                        │  Cloudflare Workers     │
               │ (Job History)  │                        │ (Deployed URL)          │
               └────────────────┘                        └─────────────────────────┘
                        │
                        ▼
               ┌────────────────┐
               │     R2 Logs    │
               │ (Build/Deploy) │
               └────────────────┘
```

1. CLI sends your prompt to the Cloudflare Worker
2. Worker creates a job record in D1 and asks Claude to generate code
3. Generated files are written to an isolated Sandbox container
4. Dependencies install and build run automatically
5. Build output is deployed to a per-job Cloudflare Worker URL
6. Build and deploy logs are stored in R2

## Framework Registry

Nimbus uses a lightweight framework registry in the worker to normalize outputs and ensure builds are deployable.

- Detects frameworks based on `nimbus.config.json`, `package.json`, or framework config files.
- Normalizes `nimbus.config.json` with `framework`, `target`, `assetsDir`, and `workerEntry` for the deploy step.
- Adds required framework dependencies to `package.json` (for example, Astro SSR adapter packages).
- Adds framework-specific prompt rules only for the selected framework to keep LLM context small.
- Supported targets are `workers` (SSR) and `static`.

Example `nimbus.config.json`:

```json
{
  "framework": "astro",
  "target": "workers",
  "assetsDir": "dist",
  "workerEntry": "dist/_worker.js/index.js"
}
```

Static-only example:

```json
{
  "framework": "astro",
  "target": "static",
  "assetsDir": "dist"
}
```

## CLI Commands

```bash
# Start a new build (opens model picker)
nimbus start "Build a portfolio site"

# Start with a specific model (skips picker)
nimbus start -m anthropic/claude-sonnet-4 "Build a todo app"

# List your job history
nimbus list

# Watch a specific job's status
nimbus watch <job-id>

# Fetch build or deploy logs
nimbus logs <job-id> --type build
```

## Self-Hosting Guide

### Prerequisites

- **Node.js** 18+ and **pnpm** 9+
- **Docker Desktop** running locally (required for Cloudflare Containers)
- **Cloudflare account** (Workers Paid plan required for Containers)
- **OpenRouter API key** ([get one here](https://openrouter.ai/keys))
- **R2 enabled** in the Cloudflare dashboard

### 1. Clone and Install

```bash
git clone https://github.com/dayhaysoos/nimbus.git
cd nimbus
pnpm install
```

### 2. Create a D1 Database

```bash
cd packages/worker

# Create the database
npx wrangler d1 create nimbus-db

# Note the database_id from the output, you'll need it for wrangler.toml
```

### 3. Enable R2 and Create a Bucket

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **R2**
2. Click **Enable R2** and accept the terms
3. Create a bucket named `nimbus-logs`

### 4. Configure the Worker

Edit `packages/worker/wrangler.toml`:

```toml
name = "nimbus-worker"
main = "src/index.ts"
compatibility_date = "2025-01-21"
compatibility_flags = ["nodejs_compat"]

# Enable workers.dev access
workers_dev = true

[vars]
DEFAULT_MODEL = "anthropic/claude-sonnet-4"

# D1 Database - replace database_id with yours from step 2
[[d1_databases]]
binding = "DB"
database_name = "nimbus-db"
database_id = "your-database-id-here"

# R2 bucket for build/deploy logs
[[r2_buckets]]
binding = "LOGS_BUCKET"
bucket_name = "nimbus-logs"

# Sandbox container configuration
[[containers]]
class_name = "Sandbox"
image = "./Dockerfile"

[durable_objects]
bindings = [{ name = "Sandbox", class_name = "Sandbox" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Sandbox"]
```

**Replace:**
- `database_id` with the ID from step 2

### 5. Run Database Migrations

```bash
cd packages/worker
npx wrangler d1 migrations apply nimbus-db --remote
```

### 6. Set Secrets

```bash
cd packages/worker

# OpenRouter API key (for LLM access)
npx wrangler secret put OPENROUTER_API_KEY
# Paste your API key when prompted

# Cloudflare API token (for Workers deploy + cleanup)
# Create at: https://dash.cloudflare.com/profile/api-tokens
# Required permissions: Workers Scripts - Edit, R2 - Edit, D1 - Edit
npx wrangler secret put CLOUDFLARE_API_TOKEN

# Cloudflare Account ID (find in dashboard URL or sidebar)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID

# Auth token for log endpoint (choose any random string)
npx wrangler secret put AUTH_TOKEN
```

### 7. Deploy

Make sure Docker Desktop is running, then:

```bash
cd packages/worker
npx wrangler deploy
```

First deployment takes 2-3 minutes (builds the container image). You'll see output like:

```
Uploaded nimbus-worker (8.45 sec)
Building image nimbus-worker-sandbox:abc123
...
Deployed nimbus-worker triggers
  *.yourdomain.com/* (zone name: yourdomain.com)
```

**Wait 2-3 minutes** after first deploy for the container to provision before testing.

### 8. Deploy Cleanup Worker

```bash
cd packages/cleanup-worker

# Set Cloudflare API token and account ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID

# Deploy the cleanup worker (runs hourly)
npx wrangler deploy
```

### 9. Test the Deployment

```bash
# Health check
curl https://your-worker-name.workers.dev/health
```

### 10. Use the CLI

```bash
# Option 1: Inline
NIMBUS_WORKER_URL=https://your-worker-name.workers.dev npx @dayhaysoos/nimbus start "Build a landing page"

# Option 2: Export for session
export NIMBUS_WORKER_URL=https://your-worker-name.workers.dev
export NIMBUS_AUTH_TOKEN=your-auth-token
npx @dayhaysoos/nimbus start "Build a landing page"

# Option 3: Add to shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export NIMBUS_WORKER_URL=https://your-worker-name.workers.dev' >> ~/.zshrc
echo 'export NIMBUS_AUTH_TOKEN=your-auth-token' >> ~/.zshrc
```

## Usage

```bash
# Set your worker URL first
export NIMBUS_WORKER_URL=https://your-worker-name.workers.dev
export NIMBUS_AUTH_TOKEN=your-auth-token

# Start a build (interactive model picker)
npx @dayhaysoos/nimbus start "Build a portfolio site for a photographer"

# Start with a specific model
npx @dayhaysoos/nimbus start -m anthropic/claude-sonnet-4 "Create a todo app"

# List your job history
npx @dayhaysoos/nimbus list

# Watch a job's progress
npx @dayhaysoos/nimbus watch job_abc12345
```

The CLI will show progress and output URLs:

```
┌  @dayhaysoos/nimbus
│
◇  Job created: job_abc12345
◇  Generated 3 files
◇  Build complete
◇  Deploying...
◇  Done
│
└  Deployed: https://job-abc12345.workers.dev
```

## Project Structure

```
nimbus/
├── packages/
│   ├── cli/                    # @dayhaysoos/nimbus CLI
│   │   └── src/
│   │       ├── index.ts        # CLI entry + command router
│   │       ├── commands/       # start, list, watch commands
│   │       └── lib/            # API client, model picker, types
│   ├── cleanup-worker/          # TTL cleanup worker
│   │   └── src/
│   │       └── index.ts        # Scheduled cleanup
│   └── worker/                 # Cloudflare Worker
│       ├── src/
│       │   ├── index.ts        # API routes
│       │   ├── api/jobs.ts     # Job creation & SSE streaming
│       │   ├── openrouter.ts   # LLM client
│       │   ├── sandbox.ts      # Container orchestration
│       │   ├── lib/
│       │   │   ├── db.ts       # D1 database operations
│       │   │   └── deploy/     # Workers deployment
│       │   └── types.ts        # TypeScript types
│       ├── migrations/         # D1 database migrations
│       ├── wrangler.toml       # Cloudflare config
│       └── Dockerfile          # Sandbox container
├── package.json                # Workspace root
└── pnpm-workspace.yaml
```

## Configuration Options

### Environment Variables (wrangler.toml `[vars]`)

| Variable | Description | Default |
|----------|-------------|---------|
| `DEFAULT_MODEL` | OpenRouter model ID | `anthropic/claude-sonnet-4` |

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers, R2, D1 permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `AUTH_TOKEN` | Auth token for log endpoint |

### Changing the LLM Model

You can select a model interactively when running `nimbus start`, or specify one with the `-m` flag:

```bash
nimbus start -m openai/gpt-4o "Build a landing page"
```

Available models include:
- `anthropic/claude-sonnet-4` (default)
- `anthropic/claude-opus-4`
- `openai/gpt-4o`
- `openai/gpt-4.1`
- `google/gemini-2.5-pro`
- `deepseek/deepseek-r1`
- `meta-llama/llama-4-maverick`

Or enter any model ID from [OpenRouter Models](https://openrouter.ai/models).

## API Reference

### `POST /api/jobs`

Creates a new job and streams SSE events while generating and building.

**Request:**
```json
{
  "prompt": "Build a landing page for a SaaS product",
  "model": "anthropic/claude-sonnet-4"
}
```

**SSE Events:**
```
data: {"type":"job_created","jobId":"job_abc12345"}
data: {"type":"generating"}
data: {"type":"generated","fileCount":3}
data: {"type":"scaffolding"}
data: {"type":"writing"}
data: {"type":"installing"}
data: {"type":"building"}
data: {"type":"log","phase":"build","message":"..."}
data: {"type":"deploying"}
data: {"type":"deployed","deployedUrl":"https://job-abc12345.workers.dev"}
data: {"type":"complete","previewUrl":"...","deployedUrl":"https://job-abc12345.workers.dev"}
```

### `GET /api/jobs`

Lists all jobs.

**Response:**
```json
{
  "jobs": [
    {
      "id": "job_abc12345",
      "prompt": "Build a landing page",
      "model": "anthropic/claude-sonnet-4",
      "status": "completed",
      "createdAt": "2025-01-22 12:00:00",
      "deployedUrl": "https://job-abc12345.workers.dev"
    }
  ]
}
```

### `GET /api/jobs/:id`

Gets a specific job's details.

### `GET /api/jobs/:id/logs?type=build|deploy`

Fetches build or deploy logs for a job. Requires the `Auth` header to match `AUTH_TOKEN`.

```bash
curl -H "Auth: $NIMBUS_AUTH_TOKEN" \
  "$NIMBUS_WORKER_URL/api/jobs/job_abc123/logs?type=deploy"
```

### `GET /health`

Returns `{"status":"ok"}` if the worker is running.

## Troubleshooting

### "OPENROUTER_API_KEY not configured"

```bash
cd packages/worker
npx wrangler secret put OPENROUTER_API_KEY
```

### Workers deployment fails

Ensure you've set these secrets on the worker:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

The API token needs **Workers Scripts - Edit**, **R2 - Edit**, and **D1 - Edit** permissions.

Fetch deploy logs for details:

```bash
NIMBUS_AUTH_TOKEN=your-token nimbus logs <job-id> --type deploy
```

### R2 not enabled (error 10042)

Enable R2 in the Cloudflare Dashboard (R2 → Enable). Then retry deploy.

### "Unauthorized" when fetching logs

Make sure `AUTH_TOKEN` is set on the worker and `NIMBUS_AUTH_TOKEN` is set locally.

### Container Not Starting

- Ensure Docker Desktop is running when you deploy
- Wait 2-3 minutes after first deployment
- Check container status: `npx wrangler containers list`

## Local Development

```bash
# Terminal 1: Start the worker locally
pnpm dev

# Terminal 2: Run CLI against local worker
NIMBUS_WORKER_URL=http://localhost:8787 npx @dayhaysoos/nimbus start "Build a hello world page"
```

> **Note**: Deployments and log uploads require Cloudflare credentials. If secrets are not configured, local builds will fail at deploy time.

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

MIT

## Acknowledgments

- [Cloudflare](https://cloudflare.com) for Workers, Containers, R2, and D1
- [Anthropic](https://anthropic.com) for Claude
- [OpenRouter](https://openrouter.ai) for the unified LLM API
