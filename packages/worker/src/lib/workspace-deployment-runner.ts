import type { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../types.js';
import {
  appendWorkspaceDeploymentEvent,
  claimWorkspaceDeploymentForExecution,
  getLatestSuccessfulWorkspaceDeployment,
  getWorkspace,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  hasWorkspaceDeploymentEvent,
  getWorkspaceOperation,
  getWorkspaceTask,
  markWorkspaceDeploymentSucceededIfNotCancelled,
  requestWorkspaceDeploymentCancel,
  updateWorkspaceDeploymentStatus,
  updateWorkspaceDeploymentSummary,
} from './db.js';
import { loadRuntimeFlags } from './flags.js';

const WORKSPACE_ROOT = '/workspace';
const STALE_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

class PolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

interface DeploymentValidationOptions {
  runBuildIfPresent: boolean;
  runTestsIfPresent: boolean;
}

class CancelRequestedError extends Error {
  constructor() {
    super('Deployment cancel requested');
    this.name = 'CancelRequestedError';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized < min) {
    return min;
  }
  if (normalized > max) {
    return max;
  }
  return normalized;
}

function isTransientFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(timeout|timed out|temporar|network|fetch failed|connection reset|sandbox unavailable|rate limit|database is locked|sqlite_busy)/i.test(
    message
  );
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

async function sha256Hex(input: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }

  throw new Error('No base64 decoder is available in this runtime');
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

let sandboxResolver: (env: Env, sandboxId: string) => Promise<SandboxClient> = getWorkspaceSandbox;

export function setWorkspaceDeploymentSandboxResolverForTests(
  resolver: ((env: Env, sandboxId: string) => Promise<SandboxClient>) | null
): void {
  sandboxResolver = resolver ?? getWorkspaceSandbox;
}

async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<string> {
  const result = await sandbox.exec(command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
  return result.stdout;
}

async function ensureWorkspaceGitBaseline(sandbox: SandboxClient): Promise<void> {
  const result = await sandbox.exec(`cd ${shellQuote(WORKSPACE_ROOT)} && git rev-parse --verify HEAD >/dev/null 2>&1`);
  if (result.exitCode !== 0) {
    throw new PolicyError('baseline_missing', 'Workspace git baseline is missing');
  }
}

async function tryRehydrateWorkspaceGitBaseline(sandbox: SandboxClient): Promise<boolean> {
  const result = await sandbox.exec(
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && git init -q && git config user.email nimbus@app.local && git config user.name Nimbus && git add -A && git commit -q --allow-empty -m 'Nimbus baseline'`
  );
  return result.exitCode === 0;
}

async function detectPackageScripts(sandbox: SandboxClient): Promise<{ hasBuild: boolean; hasTest: boolean }> {
  const output = await runSandboxCommand(
    sandbox,
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && python3 - <<'PY'\n# nimbus_detect_scripts\nimport json\nimport os\n\npath = 'package.json'\nif not os.path.exists(path):\n    print(json.dumps({'hasBuild': False, 'hasTest': False}))\n    raise SystemExit(0)\ntry:\n    with open(path, 'r', encoding='utf-8') as f:\n        payload = json.load(f)\nexcept Exception:\n    print(json.dumps({'hasBuild': False, 'hasTest': False}))\n    raise SystemExit(0)\nscripts = payload.get('scripts', {}) if isinstance(payload, dict) else {}\nprint(json.dumps({'hasBuild': bool(isinstance(scripts, dict) and scripts.get('build')), 'hasTest': bool(isinstance(scripts, dict) and scripts.get('test'))}))\nPY`
  );
  const parsed = JSON.parse(output) as { hasBuild?: boolean; hasTest?: boolean };
  return {
    hasBuild: Boolean(parsed.hasBuild),
    hasTest: Boolean(parsed.hasTest),
  };
}

function parseValidationToolMissing(output: string): { tool: string; raw: string } | null {
  const normalized = output.toLowerCase();
  const knownTools = ['pnpm', 'npm', 'yarn', 'bun'];
  for (const tool of knownTools) {
    if (normalized.includes(`${tool}: not found`) || normalized.includes(`${tool}: command not found`)) {
      return { tool, raw: output };
    }
  }
  if (normalized.includes('command not found')) {
    return { tool: 'unknown', raw: output };
  }
  return null;
}

async function runValidationStep(
  sandbox: SandboxClient,
  command: string,
  timeout: number,
  missingToolCode: string
): Promise<void> {
  const result = await sandbox.exec(command, { timeout });
  if (result.exitCode === 0) {
    return;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const missingTool = parseValidationToolMissing(output);
  if (missingTool) {
    throw new PolicyError(
      missingToolCode,
      `Validation tool is missing in sandbox runtime (${missingTool.tool}); disable this validation step or install the tool`
    );
  }

  throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
}

async function detectPotentialSecrets(sandbox: SandboxClient): Promise<string[]> {
  const output = await runSandboxCommand(
    sandbox,
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && python3 - <<'PY'\n# nimbus_detect_secrets\nimport json\nimport os\nimport re\n\npattern = re.compile(r'(^|/)(\\.env(\\.|$)|id_rsa|id_dsa|.*\\.pem$|.*\\.p12$|.*\\.key$)', re.IGNORECASE)\nallowed_env_templates = re.compile(r'(^|/)\\.env\\.(example|sample|template|dist|defaults)(\\.|$)', re.IGNORECASE)\nexcluded_dirs = {'.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'dist', 'build', 'coverage', 'target'}\nroot = os.getcwd()\nmatches = []\nfor dirpath, dirnames, filenames in os.walk(root):\n    rel_dir = os.path.relpath(dirpath, root)\n    if rel_dir == '.':\n        rel_dir = ''\n    if rel_dir and any(part in excluded_dirs for part in rel_dir.split(os.sep)):\n        continue\n    dirnames[:] = [d for d in dirnames if d not in excluded_dirs]\n    for name in filenames:\n        absolute = os.path.join(dirpath, name)\n        rel = os.path.relpath(absolute, root).replace('\\\\', '/')\n        if allowed_env_templates.search(rel):\n            continue\n        if pattern.search(rel):\n            matches.append(rel)\nprint(json.dumps(matches[:25]))\nPY`
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === 'string').slice(0, 25);
}

async function createDeploymentBundle(
  sandbox: SandboxClient
): Promise<{ bytes: Uint8Array; sha256: string; objectKeySuffix: string }> {
  const base64 = await runSandboxCommand(
    sandbox,
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && tmp_stem=$(mktemp /tmp/nimbus-workspace-deploy.XXXXXX) && tmp_bundle="\${tmp_stem}.tar.gz" && tar -czf "$tmp_bundle" --exclude='.git' . && base64 "$tmp_bundle" && rm -f "$tmp_bundle" "$tmp_stem"`,
    { timeout: 8 * 60 * 1000 }
  );
  const bytes = fromBase64(base64);
  const sha = await sha256Hex(bytes);
  return {
    bytes,
    sha256: sha,
    objectKeySuffix: 'source.tar.gz',
  };
}

async function resolveRollbackContext(workspaceId: string, deploymentId: string, enabled: boolean, env: Env): Promise<unknown> {
  if (!enabled) {
    return { status: 'disabled' };
  }
  const previous = await getLatestSuccessfulWorkspaceDeployment(env.DB, workspaceId);
  if (!previous || previous.id === deploymentId) {
    return { status: 'no_previous_success' };
  }
  return {
    status: 'retained_previous',
    deploymentId: previous.id,
    deployedUrl: previous.deployedUrl,
    providerDeploymentId: previous.providerDeploymentId,
  };
}

async function resolveRollbackContextSafely(
  workspaceId: string,
  deploymentId: string,
  enabled: boolean,
  env: Env
): Promise<unknown> {
  try {
    return await resolveRollbackContext(workspaceId, deploymentId, enabled, env);
  } catch (error) {
    return {
      status: 'lookup_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function reconcileWorkspaceSummaryForTerminalDeployment(
  env: Env,
  workspaceId: string,
  deploymentId: string
): Promise<void> {
  const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return;
  }

  if (deployment.status === 'succeeded') {
    const hasSucceededEvent = await hasWorkspaceDeploymentEvent(
      env.DB,
      workspaceId,
      deploymentId,
      'deployment_succeeded'
    );
    if (!hasSucceededEvent) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_succeeded',
        payload: {
          deployedUrl: deployment.deployedUrl,
          sourceBundleKey: deployment.sourceBundleKey,
          sourceSnapshotSha256: deployment.sourceSnapshotSha256,
        },
      });
    }

    await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
      deploymentId: deployment.id,
      status: 'succeeded',
      deployedUrl: deployment.deployedUrl,
      deployedAt: deployment.finishedAt,
      errorCode: null,
      errorMessage: null,
    });
    return;
  }

  if (deployment.status === 'failed') {
    const hasFailedEvent = await hasWorkspaceDeploymentEvent(env.DB, workspaceId, deploymentId, 'deployment_failed');
    if (!hasFailedEvent) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_failed',
        payload: {
          code: deployment.error?.code ?? 'deployment_failed',
          message: deployment.error?.message ?? 'Deployment failed',
        },
      });
    }

    await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
      deploymentId: deployment.id,
      status: 'failed',
      errorCode: deployment.error?.code ?? null,
      errorMessage: deployment.error?.message ?? null,
    });
    return;
  }

  if (deployment.status === 'cancelled') {
    const hasCancelledEvent = await hasWorkspaceDeploymentEvent(
      env.DB,
      workspaceId,
      deploymentId,
      'deployment_cancelled'
    );
    if (!hasCancelledEvent) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_cancelled',
        payload: { reason: 'cancel_requested' },
      });
    }

    await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
      deploymentId: deployment.id,
      status: 'cancelled',
      errorCode: null,
      errorMessage: null,
    });
  }
}

async function markDeploymentCancelled(
  env: Env,
  workspaceId: string,
  deploymentId: string,
  reason: string
): Promise<void> {
  await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'cancelled', {
    workspaceId,
    result: { reason },
    errorCode: null,
    errorMessage: null,
  });
  await appendWorkspaceDeploymentEvent(env.DB, {
    workspaceId,
    deploymentId,
    eventType: 'deployment_cancelled',
    payload: { reason },
  });
  await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
    deploymentId,
    status: 'cancelled',
    errorCode: null,
    errorMessage: null,
  });
}

function isRunningDeploymentStale(startedAt: string | null): boolean {
  if (!startedAt) {
    return false;
  }

  const startedAtEpochMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtEpochMs)) {
    return false;
  }

  return Date.now() - startedAtEpochMs >= STALE_RUNNING_TIMEOUT_MS;
}

async function throwIfDeploymentCancelled(env: Env, workspaceId: string, deploymentId: string): Promise<void> {
  const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (latest?.cancelRequestedAt) {
    throw new CancelRequestedError();
  }
}

async function executeWorkspaceDeployment(env: Env, workspaceId: string, deploymentId: string): Promise<void> {
  const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return;
  }
  const payload = await getWorkspaceDeploymentRequestPayload(env.DB, deploymentId);
  if (!payload) {
    throw new PolicyError('deployment_not_found', 'Deployment payload no longer exists');
  }

  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status !== 'ready') {
    throw new PolicyError('workspace_not_ready', 'Workspace is not ready for deployment');
  }

  const sandbox = await sandboxResolver(env, workspace.sandboxId);
  try {
    await ensureWorkspaceGitBaseline(sandbox);
  } catch (error) {
    if (!(error instanceof PolicyError) || error.code !== 'baseline_missing') {
      throw error;
    }

    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_baseline_rehydrate_attempted',
      payload: {},
    });

    const rehydrated = await tryRehydrateWorkspaceGitBaseline(sandbox);
    if (!rehydrated) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_baseline_rehydrate_failed',
        payload: {},
      });
      throw new PolicyError('baseline_rehydrate_failed', 'Workspace git baseline is missing and could not be rehydrated');
    }

    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_baseline_rehydrate_succeeded',
      payload: {},
    });
  }

  const provenance =
    payload.provenance && typeof payload.provenance === 'object' && !Array.isArray(payload.provenance)
      ? (payload.provenance as Record<string, unknown>)
      : {};
  const taskId = typeof provenance.taskId === 'string' ? provenance.taskId : null;
  const operationId = typeof provenance.operationId === 'string' ? provenance.operationId : null;
  if (taskId) {
    const task = await getWorkspaceTask(env.DB, workspaceId, taskId);
    if (!task) {
      throw new PolicyError('invalid_provenance_task', 'Referenced taskId does not belong to workspace');
    }
  }
  if (operationId) {
    const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
    if (!operation) {
      throw new PolicyError('invalid_provenance_operation', 'Referenced operationId does not belong to workspace');
    }
  }

  const validation =
    payload.validation && typeof payload.validation === 'object' && !Array.isArray(payload.validation)
      ? (payload.validation as Record<string, unknown>)
      : {};
  const validationOptions: DeploymentValidationOptions = {
    runBuildIfPresent: parseBoolean(validation.runBuildIfPresent, true),
    runTestsIfPresent: parseBoolean(validation.runTestsIfPresent, true),
  };
  const { runBuildIfPresent, runTestsIfPresent } = validationOptions;
  const rollbackOnFailure = parseBoolean(payload.rollbackOnFailure, true);

  await appendWorkspaceDeploymentEvent(env.DB, {
    workspaceId,
    deploymentId,
    eventType: 'deployment_started',
    payload: {
      provider: deployment.provider,
      attemptCount: deployment.attemptCount,
      runBuildIfPresent,
      runTestsIfPresent,
    },
  });

  await throwIfDeploymentCancelled(env, workspaceId, deploymentId);

  const scripts = await detectPackageScripts(sandbox);
  await throwIfDeploymentCancelled(env, workspaceId, deploymentId);

  const potentialSecrets = await detectPotentialSecrets(sandbox);
  if (potentialSecrets.length > 0) {
    throw new PolicyError(
      'potential_secrets_detected',
      `Potential secrets detected in workspace files: ${potentialSecrets.join(', ')}`
    );
  }

  if (runTestsIfPresent && scripts.hasTest) {
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'validation_started',
      payload: { step: 'test' },
    });
    try {
      await runValidationStep(
        sandbox,
        `cd ${shellQuote(WORKSPACE_ROOT)} && npm run -s test`,
        10 * 60 * 1000,
        'validation_tool_missing'
      );
    } catch (error) {
      if (error instanceof PolicyError && error.code === 'validation_tool_missing') {
        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId,
          eventType: 'deployment_validation_tool_missing',
          payload: { step: 'test', message: error.message },
        });
      }
      throw error;
    }
    await throwIfDeploymentCancelled(env, workspaceId, deploymentId);
  }
  if (runBuildIfPresent && scripts.hasBuild) {
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'validation_started',
      payload: { step: 'build' },
    });
    try {
      await runValidationStep(
        sandbox,
        `cd ${shellQuote(WORKSPACE_ROOT)} && npm run -s build`,
        10 * 60 * 1000,
        'validation_tool_missing'
      );
    } catch (error) {
      if (error instanceof PolicyError && error.code === 'validation_tool_missing') {
        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId,
          eventType: 'deployment_validation_tool_missing',
          payload: { step: 'build', message: error.message },
        });
      }
      throw error;
    }
    await throwIfDeploymentCancelled(env, workspaceId, deploymentId);
  }

  const { bytes, sha256, objectKeySuffix } = await createDeploymentBundle(sandbox);
  await throwIfDeploymentCancelled(env, workspaceId, deploymentId);
  const bucket = env.WORKSPACE_ARTIFACTS ?? env.SOURCE_BUNDLES;
  if (!bucket) {
    throw new Error('No artifact bucket is configured for workspace deployment');
  }

  const sourceBundleKey = `workspaces/${workspaceId}/deployments/${deploymentId}/${objectKeySuffix}`;
  await bucket.put(sourceBundleKey, bytes, {
    httpMetadata: {
      contentType: 'application/gzip',
    },
    customMetadata: {
      workspace_id: workspaceId,
      deployment_id: deploymentId,
      source_snapshot_sha256: sha256,
    },
  });
  await throwIfDeploymentCancelled(env, workspaceId, deploymentId);

  const deployBase = (env.WORKSPACE_DEPLOY_BASE_URL ?? 'https://deployments.nimbus.local').replace(/\/+$/, '');
  const deployedUrl = `${deployBase}/${workspaceId}/${deploymentId}`;
  const finishedAt = new Date().toISOString();
  const successResult = {
    url: deployedUrl,
    artifact: {
      sourceBundleKey,
      sourceSnapshotSha256: sha256,
    },
    provenance: {
      workspaceId,
      taskId,
      operationId,
      trigger: typeof provenance.trigger === 'string' ? provenance.trigger : 'manual',
    },
    rollbackOnFailure,
  };

  const markedSucceeded = await markWorkspaceDeploymentSucceededIfNotCancelled(env.DB, {
    workspaceId,
    deploymentId,
    sourceSnapshotSha256: sha256,
    sourceBundleKey,
    deployedUrl,
    providerDeploymentId: deploymentId,
    result: successResult,
    finishedAt,
  });

  if (!markedSucceeded) {
    const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (latest?.cancelRequestedAt) {
      await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
    }
    return;
  }

  await appendWorkspaceDeploymentEvent(env.DB, {
    workspaceId,
    deploymentId,
    eventType: 'deployment_succeeded',
    payload: {
      deployedUrl,
      sourceBundleKey,
      sourceSnapshotSha256: sha256,
    },
  });

  await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
    deploymentId,
    status: 'succeeded',
    deployedUrl,
    deployedAt: finishedAt,
    errorCode: null,
    errorMessage: null,
  });
}

export async function runWorkspaceDeploymentPreflight(
  env: Env,
  workspaceId: string,
  options?: Partial<DeploymentValidationOptions>
): Promise<{
  ok: boolean;
  checks: Array<{ code: string; ok: boolean; details?: string }>;
}> {
  const checks: Array<{ code: string; ok: boolean; details?: string }> = [];
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status !== 'ready') {
    checks.push({ code: 'workspace_ready', ok: false, details: 'Workspace is not ready' });
    return { ok: false, checks };
  }
  checks.push({ code: 'workspace_ready', ok: true });

  const sandbox = await sandboxResolver(env, workspace.sandboxId);
  try {
    await ensureWorkspaceGitBaseline(sandbox);
    checks.push({ code: 'git_baseline', ok: true });
  } catch (error) {
    checks.push({ code: 'git_baseline', ok: false, details: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  const scripts = await detectPackageScripts(sandbox);
  checks.push({
    code: 'detected_scripts',
    ok: true,
    details: JSON.stringify({ hasBuild: scripts.hasBuild, hasTest: scripts.hasTest }),
  });

  const secrets = await detectPotentialSecrets(sandbox);
  if (secrets.length > 0) {
    checks.push({ code: 'secret_scan', ok: false, details: secrets.join(', ') });
    return { ok: false, checks };
  }
  checks.push({ code: 'secret_scan', ok: true });

  const runBuildIfPresent = parseBoolean(options?.runBuildIfPresent, true);
  const runTestsIfPresent = parseBoolean(options?.runTestsIfPresent, true);
  if ((runBuildIfPresent && scripts.hasBuild) || (runTestsIfPresent && scripts.hasTest)) {
    const npmCheck = await sandbox.exec('command -v npm >/dev/null 2>&1');
    if (npmCheck.exitCode !== 0) {
      checks.push({ code: 'validation_tooling', ok: false, details: 'npm is not available in sandbox runtime' });
      return { ok: false, checks };
    }
  }
  checks.push({ code: 'validation_tooling', ok: true });

  return { ok: true, checks };
}

export async function processWorkspaceDeployment(env: Env, workspaceId: string, deploymentId: string): Promise<void> {
  const claimed = await claimWorkspaceDeploymentForExecution(env.DB, workspaceId, deploymentId);
  if (!claimed) {
    const existing = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (existing && existing.status !== 'queued' && existing.status !== 'running') {
      try {
        await reconcileWorkspaceSummaryForTerminalDeployment(env, workspaceId, deploymentId);
      } catch (reconcileError) {
        if (shouldRetryWorkspaceDeploymentError(reconcileError)) {
          throw new QueueRetryError('Terminal deployment reconciliation failed; retry requested');
        }
      }
      return;
    }

    if (existing?.status === 'queued' && existing.cancelRequestedAt) {
      await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
      return;
    }

    if (existing?.status === 'running') {
      if (existing.cancelRequestedAt) {
        await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
        return;
      }

      if (isRunningDeploymentStale(existing.startedAt)) {
        await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'failed', {
          workspaceId,
          errorCode: 'deployment_stale_timeout',
          errorMessage: 'Deployment execution exceeded stale running timeout and was failed for recovery',
        });
        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId,
          eventType: 'deployment_failed',
          payload: {
            code: 'deployment_stale_timeout',
            message: 'Deployment execution exceeded stale running timeout and was failed for recovery',
          },
        });
        await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
          deploymentId,
          status: 'failed',
          errorCode: 'deployment_stale_timeout',
          errorMessage: 'Deployment execution exceeded stale running timeout and was failed for recovery',
        });
        return;
      }

      throw new QueueRetryError('Workspace deployment is already running; defer redelivery');
    }
    return;
  }

  try {
    const flags = await loadRuntimeFlags(env);
    if (!flags.workspaceDeployEnabled) {
      await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'failed', {
        workspaceId,
        errorCode: 'workspace_deploy_disabled',
        errorMessage: 'Workspace deploy is disabled',
      });
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_failed',
        payload: { code: 'workspace_deploy_disabled', message: 'Workspace deploy is disabled' },
      });
      await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
        deploymentId,
        status: 'failed',
        errorCode: 'workspace_deploy_disabled',
        errorMessage: 'Workspace deploy is disabled',
      });
      return;
    }

    await executeWorkspaceDeployment(env, workspaceId, deploymentId);
  } catch (error) {
    const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (deployment && deployment.status !== 'queued' && deployment.status !== 'running') {
      try {
        await reconcileWorkspaceSummaryForTerminalDeployment(env, workspaceId, deploymentId);
      } catch (reconcileError) {
        if (shouldRetryWorkspaceDeploymentError(reconcileError)) {
          throw new QueueRetryError('Terminal deployment reconciliation failed; retry requested');
        }
      }
      return;
    }

    if (error instanceof CancelRequestedError || deployment?.cancelRequestedAt) {
      await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
      return;
    }

    if (error instanceof PolicyError) {
      const rollbackOnFailure = parseBoolean(
        (await getWorkspaceDeploymentRequestPayload(env.DB, deploymentId))?.rollbackOnFailure,
        true
      );
      const rollback = await resolveRollbackContextSafely(workspaceId, deploymentId, rollbackOnFailure, env);

      await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'failed', {
        workspaceId,
        errorCode: error.code,
        errorMessage: error.message,
        result: { rollback },
      });
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_failed',
        payload: { code: error.code, message: error.message, rollback },
      });
      await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
        deploymentId,
        status: 'failed',
        errorCode: error.code,
        errorMessage: error.message,
      });
      return;
    }

    const attemptCount = deployment?.attemptCount ?? 0;
    const maxRetries = deployment?.maxRetries ?? 0;
    if ((error instanceof QueueRetryError || isTransientFailure(error)) && attemptCount <= maxRetries) {
      const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
      if (latest?.cancelRequestedAt) {
        await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
        return;
      }

      await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'queued', {
        workspaceId,
        startedAt: null,
        finishedAt: null,
        errorCode: 'retry_scheduled',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId,
        eventType: 'deployment_retry_scheduled',
        payload: { attemptCount, maxRetries },
      });
      throw new QueueRetryError('Workspace deployment transient failure; retry requested');
    }

    const message = error instanceof Error ? error.message : String(error);
    const rollbackOnFailure = parseBoolean(
      (await getWorkspaceDeploymentRequestPayload(env.DB, deploymentId))?.rollbackOnFailure,
      true
    );
    const rollback = await resolveRollbackContextSafely(workspaceId, deploymentId, rollbackOnFailure, env);

    await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'failed', {
      workspaceId,
      errorCode: 'deployment_failed',
      errorMessage: message,
      result: { rollback },
    });
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_failed',
      payload: {
        code: 'deployment_failed',
        message,
        rollback,
      },
    });
    await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
      deploymentId,
      status: 'failed',
      errorCode: 'deployment_failed',
      errorMessage: message,
    });
  }
}

export async function runWorkspaceDeploymentInlineWithRetries(
  env: Env,
  workspaceId: string,
  deploymentId: string,
  maxCycles = 8
): Promise<void> {
  async function recoverInlineRunningDeployment(): Promise<boolean> {
    const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (!latest || latest.status !== 'running') {
      return false;
    }

    if (latest.cancelRequestedAt) {
      await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
      return true;
    }

    if (latest.attemptCount > latest.maxRetries) {
      return false;
    }

    await updateWorkspaceDeploymentStatus(env.DB, deploymentId, 'queued', {
      workspaceId,
      startedAt: null,
      finishedAt: null,
      errorCode: 'retry_scheduled',
      errorMessage: 'Recovered inline deployment retry after transient failure',
    });
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_retry_scheduled',
      payload: { attemptCount: latest.attemptCount, maxRetries: latest.maxRetries, recoveredInline: true },
    });
    return true;
  }

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    let retryableErrorRaised = false;
    try {
      await processWorkspaceDeployment(env, workspaceId, deploymentId);
    } catch (error) {
      if (error instanceof QueueRetryError && /already running; defer redelivery/i.test(error.message)) {
        try {
          const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
          if (latest?.status === 'running' && latest.cancelRequestedAt) {
            await markDeploymentCancelled(env, workspaceId, deploymentId, 'cancel_requested');
            continue;
          }
        } catch {
          // Best-effort inline recovery only.
        }
        return;
      }

      if (shouldRetryWorkspaceDeploymentError(error)) {
        retryableErrorRaised = true;
        try {
          const recovered = await recoverInlineRunningDeployment();
          if (recovered) {
            continue;
          }
        } catch {
          // Best-effort inline recovery only.
        }
      }
    }

    const latest = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (!latest) {
      return;
    }
    if (latest.status !== 'queued') {
      return;
    }
    if (retryableErrorRaised) {
      continue;
    }
    if (latest.error?.code !== 'retry_scheduled') {
      return;
    }
  }
}

export async function cancelWorkspaceDeployment(
  env: Env,
  workspaceId: string,
  deploymentId: string
): Promise<{ updated: boolean; deployment: Awaited<ReturnType<typeof getWorkspaceDeployment>> }> {
  const result = await requestWorkspaceDeploymentCancel(env.DB, workspaceId, deploymentId);
  if (result.updated && result.deployment?.status === 'cancelled') {
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_cancelled',
      payload: { reason: 'cancel_requested' },
    });
    await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
      deploymentId,
      status: 'cancelled',
      errorCode: null,
      errorMessage: null,
    });
  }
  if (result.updated && result.deployment?.status === 'running') {
    await appendWorkspaceDeploymentEvent(env.DB, {
      workspaceId,
      deploymentId,
      eventType: 'deployment_cancel_requested',
      payload: { cancelRequestedAt: result.deployment.cancelRequestedAt },
    });
  }
  return result;
}

export function shouldRetryWorkspaceDeploymentError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }
  if (isTransientFailure(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset)/i.test(message);
}
