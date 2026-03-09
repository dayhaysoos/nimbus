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
    const output = execSync(command, {
      stdio: 'pipe',
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    if (output) {
      process.stdout.write(output);
    }
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    const stderr = String(error?.stderr ?? '');
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
    const output = [
      stderr,
      stdout,
      String(error?.message ?? ''),
      String(error?.stack ?? ''),
    ]
      .join('\n')
      .toLowerCase();
    if (output.includes('already exists') || output.includes('already taken')) {
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
