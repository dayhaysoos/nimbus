import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

const APP_DIR = '/root/app';
const WRANGLER_CONFIG = 'wrangler.nimbus.toml';
const DEPLOY_LOG_PATH = `${APP_DIR}/.nimbus/deploy.log`;

export class DeployError extends Error {
  deployLog: string | null;

  constructor(message: string, deployLog: string | null) {
    super(message);
    this.deployLog = deployLog;
  }
}

function sanitizeLog(contents: string | null): string | null {
  if (!contents) {
    return null;
  }
  return contents
    .replace(/CLOUDFLARE_API_TOKEN="[^"]*"/g, 'CLOUDFLARE_API_TOKEN="[REDACTED]"')
    .replace(/CLOUDFLARE_ACCOUNT_ID="[^"]*"/g, 'CLOUDFLARE_ACCOUNT_ID="[REDACTED]"');
}

async function readDeployLog(sandbox: ReturnType<typeof getSandbox>): Promise<string | null> {
  const result = await sandbox.exec(
    `if [ -f "${DEPLOY_LOG_PATH}" ]; then cat "${DEPLOY_LOG_PATH}"; fi`
  );
  return sanitizeLog(result.stdout?.trim() || null);
}

/**
 * Deploy a Workers SSR app using a generated wrangler config
 */
export async function deployToWorkers(
  env: Env,
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string
): Promise<{ deployedUrl: string; deployLog: string | null }> {
  const sandbox = getSandbox(sandboxNamespace, sandboxId);

  const wranglerCmd = [
    `export CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}"`,
    `export CLOUDFLARE_ACCOUNT_ID="${env.CLOUDFLARE_ACCOUNT_ID}"`,
    `cd ${APP_DIR} && wrangler deploy --config ${WRANGLER_CONFIG} > "${DEPLOY_LOG_PATH}" 2>&1`,
  ].join(' && ');

  const result = await sandbox.exec(wranglerCmd);
  const deployLog = await readDeployLog(sandbox);

  if (result.exitCode !== 0) {
    console.error('[Workers] Wrangler failed:', deployLog || result.stderr || result.stdout);
    throw new DeployError(`Wrangler failed with exit code ${result.exitCode}`, deployLog);
  }

  const urlMatch = (deployLog || '').match(/https:\/\/[^\s]+\.workers\.dev/);
  if (!urlMatch) {
    console.error('[Workers] Could not parse URL from output:', deployLog || result.stdout);
    throw new DeployError('Could not parse deployment URL from wrangler output', deployLog);
  }
  const deployedUrl = urlMatch[0];

  return { deployedUrl, deployLog };
}
