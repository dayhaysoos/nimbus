import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

const APP_DIR = '/root/app';
const WRANGLER_CONFIG = 'wrangler.nimbus.toml';

/**
 * Deploy a Workers SSR app using a generated wrangler config
 */
export async function deployToWorkers(
  env: Env,
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string
): Promise<string> {
  const sandbox = getSandbox(sandboxNamespace, sandboxId);

  const wranglerCmd = [
    `export CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}"`,
    `export CLOUDFLARE_ACCOUNT_ID="${env.CLOUDFLARE_ACCOUNT_ID}"`,
    `cd ${APP_DIR} && wrangler deploy --config ${WRANGLER_CONFIG}`,
  ].join(' && ');

  const result = await sandbox.exec(wranglerCmd);

  if (result.exitCode !== 0) {
    const sanitizedOutput = (result.stderr || result.stdout)
      .replace(/CLOUDFLARE_API_TOKEN="[^"]*"/g, 'CLOUDFLARE_API_TOKEN="[REDACTED]"')
      .replace(/CLOUDFLARE_ACCOUNT_ID="[^"]*"/g, 'CLOUDFLARE_ACCOUNT_ID="[REDACTED]"');
    console.error('[Workers] Wrangler failed:', sanitizedOutput);
    throw new Error(`Wrangler failed with exit code ${result.exitCode}`);
  }

  const urlMatch = result.stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (!urlMatch) {
    console.error('[Workers] Could not parse URL from output:', result.stdout);
    throw new Error('Could not parse deployment URL from wrangler output');
  }
  const deployedUrl = urlMatch[0];

  try {
    await sandbox.destroy();
  } catch {
    // Ignore destruction errors
  }

  return deployedUrl;
}
