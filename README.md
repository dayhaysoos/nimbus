# Nimbus

An open-source CLI that generates and hosts websites using AI. Give it a prompt, get back a live preview URL.

```bash
NIMBUS_WORKER_URL=https://your-worker.com npx @dayhaysoos/nimbus "Build a coffee shop landing page"
```

> **Note**: Nimbus requires a self-hosted worker. See the [Self-Hosting Guide](#self-hosting-guide) below to set up your own instance in ~10 minutes.

**Built with:**
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless API
- [Cloudflare Containers/Sandbox SDK](https://developers.cloudflare.com/sandbox/) - Isolated code execution
- [Claude](https://anthropic.com/claude) via [OpenRouter](https://openrouter.ai/) - Code generation
- [clack](https://github.com/bombshell-dev/clack) - Beautiful CLI prompts

## How It Works

```
┌─────────┐     ┌──────────────────┐     ┌─────────────┐     ┌─────────────┐
│   CLI   │────▶│ Cloudflare Worker│────▶│   Claude    │────▶│   Sandbox   │
│         │     │   (POST /build)  │     │ (OpenRouter)│     │ (Container) │
└─────────┘     └──────────────────┘     └─────────────┘     └─────────────┘
                                                                    │
                                                                    ▼
                                                         ┌─────────────────────┐
                                                         │  Live Preview URL   │
                                                         │ https://8080-xxx... │
                                                         └─────────────────────┘
```

1. CLI sends your prompt to the Cloudflare Worker
2. Worker asks Claude to generate website code (HTML, CSS, JS, etc.)
3. Generated files are written to an isolated Sandbox container
4. If needed, `npm install` and `npm build` run automatically
5. A preview server starts and you get a live HTTPS URL

## Self-Hosting Guide

### Prerequisites

- **Node.js** 18+ and **pnpm** 9+
- **Docker Desktop** running locally (required for Cloudflare Containers)
- **Cloudflare account** (free tier works, but Workers Paid recommended)
- **OpenRouter API key** ([get one here](https://openrouter.ai/keys))
- **Custom domain** added to Cloudflare (required for preview URLs)

### 1. Clone and Install

```bash
git clone https://github.com/dayhaysoos/nimbus.git
cd nimbus
pnpm install
```

### 2. Set Up Your Custom Domain

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

### 3. Configure the Worker

Edit `packages/worker/wrangler.toml` with your domain:

```toml
name = "nimbus-worker"
main = "src/index.ts"
compatibility_date = "2025-01-21"
compatibility_flags = ["nodejs_compat"]

# Replace with YOUR domain
[[routes]]
pattern = "*.yourdomain.com/*"
zone_name = "yourdomain.com"

[vars]
DEFAULT_MODEL = "anthropic/claude-sonnet-4"
# Replace with YOUR domain (same as zone_name)
PREVIEW_HOSTNAME = "yourdomain.com"

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

**Replace `yourdomain.com` with your actual domain in both places.**

### 4. Set the OpenRouter API Key

```bash
cd packages/worker
npx wrangler secret put OPENROUTER_API_KEY
# Paste your API key when prompted
```

### 5. Deploy

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

### 6. Test the Deployment

```bash
# Health check
curl https://api.yourdomain.com/health

# Or any subdomain works since you have wildcard routing
curl https://anything.yourdomain.com/health
```

### 7. Use the CLI

The CLI requires the `NIMBUS_WORKER_URL` environment variable pointing to your worker:

```bash
# Option 1: Inline
NIMBUS_WORKER_URL=https://api.yourdomain.com npx @dayhaysoos/nimbus "Build a landing page"

# Option 2: Export for session
export NIMBUS_WORKER_URL=https://api.yourdomain.com
npx @dayhaysoos/nimbus "Build a landing page"

# Option 3: Add to shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export NIMBUS_WORKER_URL=https://api.yourdomain.com' >> ~/.zshrc
```

## Usage

```bash
# Set your worker URL first
export NIMBUS_WORKER_URL=https://api.yourdomain.com

# Then run with any prompt
npx @dayhaysoos/nimbus "Build a portfolio site for a photographer"
npx @dayhaysoos/nimbus "Create a todo app with local storage"
npx @dayhaysoos/nimbus "Build a restaurant menu page with a dark theme"
```

The CLI will show progress and output a preview URL:

```
┌  @dayhaysoos/nimbus
│
◇  Connected to worker
◇  Generated 3 files
◇  Build complete
◇  Preview server ready
│
└  Preview: https://8080-build-abc123.yourdomain.com/

●  Press Ctrl+C to stop the preview.
```

## Project Structure

```
nimbus/
├── packages/
│   ├── cli/                    # @dayhaysoos/nimbus CLI
│   │   └── src/index.ts        # CLI entry point
│   └── worker/                 # Cloudflare Worker
│       ├── src/
│       │   ├── index.ts        # API routes + SSE streaming
│       │   ├── openrouter.ts   # LLM client
│       │   ├── sandbox.ts      # Container orchestration
│       │   └── types.ts        # TypeScript types
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

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |

### Changing the LLM Model

Edit `DEFAULT_MODEL` in `wrangler.toml`:

```toml
[vars]
DEFAULT_MODEL = "anthropic/claude-sonnet-4"  # Default
# DEFAULT_MODEL = "openai/gpt-4o"            # GPT-4o
# DEFAULT_MODEL = "google/gemini-pro"        # Gemini
```

See [OpenRouter Models](https://openrouter.ai/models) for available options.

## Local Development

```bash
# Terminal 1: Start the worker locally
pnpm dev

# Terminal 2: Run CLI against local worker
NIMBUS_WORKER_URL=http://localhost:8787 npx @dayhaysoos/nimbus "Build a hello world page"

# Or from the repo
NIMBUS_WORKER_URL=http://localhost:8787 pnpm cli "Build a hello world page"
```

> **Note**: Preview URLs don't work in local development (they require the custom domain routing). The build will complete but the preview URL won't be accessible.

## Troubleshooting

### "OPENROUTER_API_KEY not configured"

```bash
cd packages/worker
npx wrangler secret put OPENROUTER_API_KEY
```

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

The sandbox may have been destroyed. Sandboxes are ephemeral - run the build again to get a new preview URL.

## API Reference

### `POST /build`

Streams SSE events while generating and building the website.

**Request:**
```json
{
  "prompt": "Build a landing page for a SaaS product"
}
```

**SSE Events:**
```
data: {"type":"generating"}
data: {"type":"generated","fileCount":3}
data: {"type":"scaffolding"}
data: {"type":"writing"}
data: {"type":"installing"}
data: {"type":"building"}
data: {"type":"starting"}
data: {"type":"complete","previewUrl":"https://8080-xxx.yourdomain.com/"}
```

### `GET /health`

Returns `{"status":"ok"}` if the worker is running.

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

MIT

## Acknowledgments

- [Cloudflare](https://cloudflare.com) for Workers and the Sandbox SDK
- [Anthropic](https://anthropic.com) for Claude
- [OpenRouter](https://openrouter.ai) for the unified LLM API
