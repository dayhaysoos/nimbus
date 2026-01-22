# Cloudflare Sandbox base image with Node.js, npm, git, etc.
FROM docker.io/cloudflare/sandbox:0.1.3

# Expose ports:
# - 3000: Sandbox internal API
# - 4321: Astro preview server
EXPOSE 3000
EXPOSE 4321

# Keep the default entrypoint from base image
CMD ["bun", "index.ts"]
