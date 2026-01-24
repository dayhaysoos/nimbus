import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

const APP_DIR = '/root/app';
const BUILD_DIRS = ['dist', 'build', '.output', 'out'];

/**
 * Deploy built files to Cloudflare Pages using Wrangler
 * 
 * Note: Only destroys the sandbox on SUCCESS. On failure, the sandbox is kept alive
 * so the preview URL remains accessible as a fallback.
 */
export async function deployToPages(
  env: Env,
  jobId: string,
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string
): Promise<string> {
  const sandbox = getSandbox(sandboxNamespace, sandboxId);
  const projectName = env.PAGES_PROJECT_NAME || 'nimbus';

  // Step 1: Find deploy path
  const deployPath = await findDeployPath(sandbox);

  // Step 2: Deploy using Wrangler
  // Set environment variables for wrangler
  const wranglerCmd = [
    `export CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}"`,
    `export CLOUDFLARE_ACCOUNT_ID="${env.CLOUDFLARE_ACCOUNT_ID}"`,
    `wrangler pages deploy "${deployPath}" --project-name="${projectName}" --branch="${jobId}" --commit-message="Nimbus deployment: ${jobId}"`
  ].join(' && ');

  const result = await sandbox.exec(wranglerCmd);

  if (result.exitCode !== 0) {
    // Sanitize output to avoid leaking tokens in error messages
    const sanitizedOutput = (result.stderr || result.stdout)
      .replace(/CLOUDFLARE_API_TOKEN="[^"]*"/g, 'CLOUDFLARE_API_TOKEN="[REDACTED]"')
      .replace(/CLOUDFLARE_ACCOUNT_ID="[^"]*"/g, 'CLOUDFLARE_ACCOUNT_ID="[REDACTED]"');
    console.error('[Pages] Wrangler failed:', sanitizedOutput);
    // Don't destroy sandbox on failure - keep preview URL alive as fallback
    throw new Error(`Wrangler failed with exit code ${result.exitCode}`);
  }

  // Parse the deployment URL from wrangler output
  // Example output: "✨ Deployment complete! Take a peek over at https://abc123.project.pages.dev"
  const urlMatch = result.stdout.match(/https:\/\/[^\s]+\.pages\.dev/);
  if (!urlMatch) {
    console.error('[Pages] Could not parse URL from output:', result.stdout);
    // Don't destroy sandbox on failure - keep preview URL alive as fallback
    throw new Error('Could not parse deployment URL from wrangler output');
  }

  const deployedUrl = urlMatch[0];

  // Only destroy sandbox on successful deployment
  // (Preview URL no longer needed since we have a permanent Pages URL)
  try {
    await sandbox.destroy();
  } catch {
    // Ignore destruction errors
  }

  return deployedUrl;
}

async function findDeployPath(sandbox: ReturnType<typeof getSandbox>): Promise<string> {
  for (const dir of BUILD_DIRS) {
    const checkPath = `${APP_DIR}/${dir}`;
    const result = await sandbox.exec(`test -d ${checkPath} && echo "exists"`);
    if (result.stdout.includes('exists')) {
      return checkPath;
    }
  }
  return APP_DIR;
}
