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
- [Cloudflare Pages](https://pages.cloudflare.com/) - Permanent hosting
- [Cloudflare D1](https://developers.cloudflare.com/d1/) - Job persistence
- [Claude](https://anthropic.com/claude) via [OpenRouter](https://openrouter.ai/) - Code generation
- [clack](https://github.com/bombshell-dev/clack) - Beautiful CLI prompts

## How It Works

```
┌─────────┐     ┌──────────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI   │────▶│ Cloudflare Worker│────▶│   Claude    │────▶│   Sandbox   │
│         │     │   (POST /api/jobs)│    │ (OpenRouter)│     │ (Container) │
└─────────┘     └──────────────────┘     └─────────────┘     └─────────────┘
                        │                                           │
                        ▼                                           ▼
               ┌────────────────┐                        ┌─────────────────────┐
               │   D1 Database  │                        │   Cloudflare Pages  │
               │ (Job History)  │                        │  (Permanent URL)    │
               └────────────────┘                        └─────────────────────┘
```

1. CLI sends your prompt to the Cloudflare Worker
2. Worker creates a job record in D1 and asks Claude to generate code
3. Generated files are written to an isolated Sandbox container
4. If needed, `npm install` and `npm build` run automatically
5. A preview server starts (temporary URL for testing)
6. Files are deployed to Cloudflare Pages (permanent URL)

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
```

## Self-Hosting Guide

### Prerequisites

- **Node.js** 18+ and **pnpm** 9+
- **Docker Desktop** running locally (required for Cloudflare Containers)
- **Cloudflare account** (Workers Paid plan required for Containers)
- **OpenRouter API key** ([get one here](https://openrouter.ai/keys))
- **Custom domain** added to Cloudflare (required for preview URLs)

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

### 3. Set Up Your Custom Domain

Preview URLs require a custom domain with wildcard DNS. The free `*.workers.dev` domain doesn't support the subdomain pattern needed.

#### Buy/Transfer a Domain

If you don't have one, you can buy a domain directly from Cloudflare:
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Domain Registration** → **Register Domain**
2. Or transfer an existing domain to Cloudflare

#### Add Wildcard DNS Record

In the Cloudflare dashboard:

1. Go to your domain → **DNS** → **Records**
2. Add a new record:
   - **Type**: `A`
   - **Name**: `*` (wildcard)
   - **IPv4 address**: `192.0.2.0`
   - **Proxy status**: **Proxied** (orange cloud ON)
   - **TTL**: Auto

> **Note**: `192.0.2.0` is a documentation IP (RFC 5737). Cloudflare recognizes this when proxied and routes traffic to your Worker.

### 4. Create a Cloudflare Pages Project

```bash
# Create the Pages project for deployments
npx wrangler pages project create nimbus
```

### 5. Configure the Worker

Edit `packages/worker/wrangler.toml`:

```toml
name = "nimbus-worker"
main = "src/index.ts"
compatibility_date = "2025-01-21"
compatibility_flags = ["nodejs_compat"]

# Enable workers.dev access
workers_dev = true

# Replace with YOUR domain
[[routes]]
pattern = "*.yourdomain.com/*"
zone_name = "yourdomain.com"

[vars]
DEFAULT_MODEL = "anthropic/claude-sonnet-4"
# Replace with YOUR domain (same as zone_name)
PREVIEW_HOSTNAME = "yourdomain.com"
# Pages project name for deployments
PAGES_PROJECT_NAME = "nimbus"

# D1 Database - replace database_id with yours from step 2
[[d1_databases]]
binding = "DB"
database_name = "nimbus-db"
database_id = "your-database-id-here"

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
- `yourdomain.com` with your actual domain (in both places)
- `database_id` with the ID from step 2

### 6. Run Database Migrations

```bash
cd packages/worker
npx wrangler d1 migrations apply nimbus-db --remote
```

### 7. Set Secrets

```bash
cd packages/worker

# OpenRouter API key (for LLM access)
npx wrangler secret put OPENROUTER_API_KEY
# Paste your API key when prompted

# Cloudflare API token (for Pages deployment)
# Create at: https://dash.cloudflare.com/profile/api-tokens
# Required permission: Cloudflare Pages - Edit
npx wrangler secret put CLOUDFLARE_API_TOKEN

# Cloudflare Account ID (find in dashboard URL or sidebar)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### 8. Deploy

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

### 9. Test the Deployment

```bash
# Health check
curl https://api.yourdomain.com/health

# Or any subdomain works since you have wildcard routing
curl https://anything.yourdomain.com/health
```

### 10. Use the CLI

```bash
# Option 1: Inline
NIMBUS_WORKER_URL=https://api.yourdomain.com npx @dayhaysoos/nimbus start "Build a landing page"

# Option 2: Export for session
export NIMBUS_WORKER_URL=https://api.yourdomain.com
npx @dayhaysoos/nimbus start "Build a landing page"

# Option 3: Add to shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export NIMBUS_WORKER_URL=https://api.yourdomain.com' >> ~/.zshrc
```

## Usage

```bash
# Set your worker URL first
export NIMBUS_WORKER_URL=https://api.yourdomain.com

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
◇  Preview ready
│
●  Preview: https://8080-build-abc123.yourdomain.com/
│
◇  Done
│
└  Deployed: https://abc123.nimbus.pages.dev
```

**Two URLs are provided:**
- **Preview URL** - Temporary, dies when sandbox times out (~10 min idle)
- **Deployed URL** - Permanent Cloudflare Pages URL

## Project Structure

```
nimbus/
├── packages/
│   ├── cli/                    # @dayhaysoos/nimbus CLI
│   │   └── src/
│   │       ├── index.ts        # CLI entry + command router
│   │       ├── commands/       # start, list, watch commands
│   │       └── lib/            # API client, model picker, types
│   └── worker/                 # Cloudflare Worker
│       ├── src/
│       │   ├── index.ts        # API routes
│       │   ├── api/jobs.ts     # Job creation & SSE streaming
│       │   ├── openrouter.ts   # LLM client
│       │   ├── sandbox.ts      # Container orchestration
│       │   ├── lib/
│       │   │   ├── db.ts       # D1 database operations
│       │   │   └── deploy/     # Pages deployment
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
| `PREVIEW_HOSTNAME` | Domain for preview URLs | (required) |
| `PAGES_PROJECT_NAME` | Cloudflare Pages project | `nimbus` |

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages Edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

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
data: {"type":"starting"}
data: {"type":"preview_ready","previewUrl":"https://8080-xxx.yourdomain.com/"}
data: {"type":"deploying"}
data: {"type":"complete","previewUrl":"...","deployedUrl":"https://xxx.nimbus.pages.dev"}
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
      "deployedUrl": "https://abc123.nimbus.pages.dev"
    }
  ]
}
```

### `GET /api/jobs/:id`

Gets a specific job's details.

### `GET /health`

Returns `{"status":"ok"}` if the worker is running.

## Troubleshooting

### "OPENROUTER_API_KEY not configured"

```bash
cd packages/worker
npx wrangler secret put OPENROUTER_API_KEY
```

### Pages deployment fails

Ensure you've set the Cloudflare secrets:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

The API token needs **Cloudflare Pages - Edit** permission.

### SSL/TLS Errors on Preview URLs

Make sure:
1. Your wildcard DNS record is **Proxied** (orange cloud)
2. SSL/TLS mode is set to **Full** or **Full (strict)** in Cloudflare dashboard
3. You're using the root domain in `PREVIEW_HOSTNAME` (e.g., `yourdomain.com` not `api.yourdomain.com`)

### "Could not resolve host" for Preview URLs

- DNS propagation can take a few minutes
- Verify the wildcard A record exists: `dig *.yourdomain.com`

### Container Not Starting

- Ensure Docker Desktop is running when you deploy
- Wait 2-3 minutes after first deployment
- Check container status: `npx wrangler containers list`

### Preview URL Returns 404

The sandbox may have been destroyed. Sandboxes are ephemeral - run the build again to get a new preview URL. The **deployed URL** (Pages) is permanent.

## Local Development

```bash
# Terminal 1: Start the worker locally
pnpm dev

# Terminal 2: Run CLI against local worker
NIMBUS_WORKER_URL=http://localhost:8787 npx @dayhaysoos/nimbus start "Build a hello world page"
```

> **Note**: Preview URLs and Pages deployment don't work in local development (they require custom domain routing and Cloudflare infrastructure). The build will complete but URLs won't be accessible.

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

MIT

## Acknowledgments

- [Cloudflare](https://cloudflare.com) for Workers, Containers, Pages, and D1
- [Anthropic](https://anthropic.com) for Claude
- [OpenRouter](https://openrouter.ai) for the unified LLM API
