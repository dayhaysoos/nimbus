# Cloudflare Sandbox base image with Node.js, npm, git, etc.
FROM docker.io/cloudflare/sandbox:0.1.3

# Install wrangler globally for Pages deployment
RUN npm install -g wrangler

# Expose ports:
# - 3000: Sandbox internal API
# - 8080: HTTP server for preview
EXPOSE 3000
EXPOSE 8080

# Keep the default entrypoint from base image
CMD ["bun", "index.ts"]
