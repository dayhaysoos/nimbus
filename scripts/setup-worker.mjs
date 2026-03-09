import { execSync } from 'node:child_process';

function run(command, options = {}) {
  execSync(command, {
    stdio: 'inherit',
    cwd: process.cwd(),
    ...options,
  });
}

function runAllowAlreadyExists(command) {
  try {
    run(command);
  } catch (error) {
    const output = String(error?.stderr ?? '') + String(error?.stdout ?? '') + String(error?.message ?? '');
    if (output.toLowerCase().includes('already exists')) {
      return;
    }
    throw error;
  }
}

function main() {
  runAllowAlreadyExists('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler queues create nimbus-workspace-deploys');
  run('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler d1 migrations apply nimbus-db --remote');
  run(
    "pnpm --filter @dayhaysoos/nimbus-worker exec wrangler d1 execute nimbus-db --remote --command \"INSERT INTO runtime_flags (key, value, updated_at) VALUES ('workspace_deploy_enabled', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');\""
  );
  run('pnpm --filter @dayhaysoos/nimbus-worker run deploy');
}

main();
