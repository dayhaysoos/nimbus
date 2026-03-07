# Cloudflare Sandbox base image with Node.js, npm, git, etc.
FROM docker.io/cloudflare/sandbox:0.1.3

# Sandbox internal API
EXPOSE 3000

# Keep the default entrypoint from base image
CMD ["bun", "index.ts"]
