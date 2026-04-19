# Cloudflare Sandbox base image with Node.js, npm, git, etc.
FROM docker.io/cloudflare/sandbox:0.1.3

# Bake pnpm into the sandbox image so validation preflight can run pnpm-based repos
# without relying on per-command corepack activation persisting across exec calls.
RUN corepack enable && npm install -g --force pnpm@9.15.0

# Sandbox internal API
EXPOSE 3000

# Keep the default entrypoint from base image
CMD ["bun", "index.ts"]
