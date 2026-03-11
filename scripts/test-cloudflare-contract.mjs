#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function optionalInt(name, fallback, min) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { response, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasFailedCheck(preflight) {
  if (!preflight || !Array.isArray(preflight.checks)) {
    return false;
  }
  return preflight.checks.some((check) => check && check.ok === false);
}

async function main() {
  const workerUrl = requiredEnv('NIMBUS_WORKER_URL').replace(/\/+$/, '');
  const workspaceId = requiredEnv('NIMBUS_WORKSPACE_ID');
  const outputDir = process.env.NIMBUS_OUTPUT_DIR?.trim() || 'dist';
  const expectedTerminalStatus = process.env.NIMBUS_EXPECT_TERMINAL_STATUS?.trim() || 'succeeded';
  const pollIntervalMs = optionalInt('NIMBUS_POLL_INTERVAL_MS', 1500, 100);
  const maxPolls = optionalInt('NIMBUS_MAX_POLLS', 80, 1);
  const idempotencyKey = `contract-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const base = `${workerUrl}/api/workspaces/${workspaceId}`;

  console.log('1) Checking deploy readiness');
  {
    const { response, body } = await requestJson(`${workerUrl}/api/system/deploy-readiness`, { method: 'GET' });
    assert(response.status === 200, `deploy-readiness expected 200, got ${response.status}`);
    assert(body && Array.isArray(body.checks), 'deploy-readiness body missing checks array');
  }

  console.log('2) Verifying missing outputDir preflight failure contract');
  {
    const { response, body } = await requestJson(`${base}/deploy/preflight`, {
      method: 'POST',
      body: JSON.stringify({ provider: 'cloudflare_workers_assets' }),
    });
    assert(response.status === 200, `preflight(no outputDir) expected 200, got ${response.status}`);
    assert(body?.preflight?.ok === false, 'preflight(no outputDir) expected preflight.ok=false');
    const hasInvalidOutputDir = Array.isArray(body?.preflight?.checks)
      ? body.preflight.checks.some((check) => check?.code === 'provider_invalid_output_dir' && check?.ok === false)
      : false;
    assert(hasInvalidOutputDir, 'preflight(no outputDir) missing provider_invalid_output_dir failed check');
  }

  console.log('3) Running provider preflight with outputDir');
  {
    const { response, body } = await requestJson(`${base}/deploy/preflight`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'cloudflare_workers_assets',
        validation: { runBuildIfPresent: false, runTestsIfPresent: false },
        deploy: { outputDir },
      }),
    });
    assert(response.status === 200, `preflight expected 200, got ${response.status}`);
    assert(body?.preflight, 'preflight response missing preflight object');
    assert(Array.isArray(body?.preflight?.checks), 'preflight response missing checks array');
    assert(!hasFailedCheck(body.preflight), 'preflight has failed checks for configured real provider');
  }

  console.log('4) Creating deployment');
  let deploymentId = null;
  {
    const { response, body } = await requestJson(`${base}/deploy`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        provider: 'cloudflare_workers_assets',
        validation: { runBuildIfPresent: false, runTestsIfPresent: false },
        retry: { maxRetries: 2 },
        deploy: { outputDir },
      }),
    });
    assert(response.status === 202 || response.status === 200, `create deploy expected 202/200, got ${response.status}`);
    deploymentId = body?.deployment?.id ?? null;
    assert(typeof deploymentId === 'string' && deploymentId.length > 0, 'create deploy missing deployment.id');
  }

  console.log('5) Verifying idempotent replay returns same deployment');
  {
    const { response, body } = await requestJson(`${base}/deploy`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        provider: 'cloudflare_workers_assets',
        validation: { runBuildIfPresent: false, runTestsIfPresent: false },
        retry: { maxRetries: 2 },
        deploy: { outputDir },
      }),
    });
    assert(response.status === 200, `replay create expected 200, got ${response.status}`);
    assert(body?.deployment?.id === deploymentId, 'replay create returned different deployment.id');
  }

  console.log('6) Polling deployment to terminal status');
  let terminalDeployment = null;
  {
    let terminal = null;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const { response, body } = await requestJson(`${base}/deployments/${deploymentId}`, { method: 'GET' });
      assert(response.status === 200, `poll expected 200, got ${response.status}`);
      const status = body?.deployment?.status;
      assert(typeof status === 'string', 'poll response missing deployment.status');
      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        terminal = status;
        terminalDeployment = body?.deployment ?? null;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    assert(terminal !== null, `poll did not reach terminal status within ${maxPolls} attempts`);
    assert(
      terminal === expectedTerminalStatus,
      `terminal status mismatch: expected ${expectedTerminalStatus}, got ${terminal}`
    );
  }

  if (expectedTerminalStatus === 'succeeded') {
    console.log('7) Verifying deployedUrl reachability for succeeded deployment');
    const deployedUrl = terminalDeployment?.deployedUrl;
    assert(typeof deployedUrl === 'string' && deployedUrl.length > 0, 'succeeded deployment missing deployedUrl');
    const probe = await fetch(deployedUrl, { method: 'GET', redirect: 'manual' });
    assert(
      probe.status >= 200 && probe.status < 400,
      `deployedUrl probe expected 2xx/3xx, got ${probe.status} for ${deployedUrl}`
    );
  }

  console.log('Cloudflare contract checks passed.');
}

main().catch((error) => {
  console.error(`Contract test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
