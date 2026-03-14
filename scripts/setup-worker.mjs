import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function run(command, options = {}) {
  const hasInput = Object.prototype.hasOwnProperty.call(options, 'input');
  const { stdio, ...restOptions } = options;
  execSync(command, {
    stdio: stdio ?? (hasInput ? ['pipe', 'inherit', 'inherit'] : 'inherit'),
    cwd: process.cwd(),
    ...restOptions,
  });
}

function runCapture(command) {
  const output = execSync(command, {
    stdio: 'pipe',
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (output) {
    process.stdout.write(output);
  }
  return output;
}

function resolveAgentEndpointUrl(deployOutput) {
  const override = process.env.NIMBUS_AGENT_SDK_URL?.trim();
  if (override) {
    return override;
  }

  const urls = Array.from(new Set((deployOutput.match(/https:\/\/[^\s)]+/g) ?? []).map((value) => value.replace(/[.,;:!?]+$/, ''))));
  if (urls.length > 0) {
    const preferred = urls.find((value) => value.includes('nimbus-agent-endpoint'));
    return preferred ?? urls[0];
  }

  throw new Error(
    'Unable to resolve nimbus-agent-endpoint URL from deploy output. Set NIMBUS_AGENT_SDK_URL explicitly and re-run setup-worker.'
  );
}

function resolveAgentAuthToken() {
  const override = process.env.NIMBUS_AGENT_SDK_AUTH_TOKEN?.trim();
  if (override) {
    return override;
  }
  return randomBytes(24).toString('hex');
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
  runAllowAlreadyExists('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler queues create nimbus-reviews');
  run('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler d1 migrations apply nimbus-db --remote');
  run(
    "pnpm --filter @dayhaysoos/nimbus-worker exec wrangler d1 execute nimbus-db --remote --command \"INSERT INTO runtime_flags (key, value, updated_at) VALUES ('workspace_deploy_enabled', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');\""
  );
  const deployOutput = runCapture('pnpm --filter @dayhaysoos/nimbus-agent-endpoint run deploy');
  const agentSdkUrl = resolveAgentEndpointUrl(deployOutput);
  const agentSdkAuthToken = resolveAgentAuthToken();
  run('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler secret put AGENT_SDK_URL', {
    input: agentSdkUrl,
  });
  run('pnpm --filter @dayhaysoos/nimbus-worker exec wrangler secret put AGENT_SDK_AUTH_TOKEN', {
    input: agentSdkAuthToken,
  });
  run('pnpm --filter @dayhaysoos/nimbus-agent-endpoint exec wrangler secret put AGENT_SDK_AUTH_TOKEN', {
    input: agentSdkAuthToken,
  });
  run('pnpm --filter @dayhaysoos/nimbus-worker run deploy');
}

main();
