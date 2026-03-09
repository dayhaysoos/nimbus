import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import {
  createWorkspaceDeployment,
  getWorkerUrl,
  getWorkspaceDeployment,
  preflightWorkspaceDeployment,
} from '../../lib/api.js';

function buildIdempotencyKey(workspaceId: string): string {
  const seed = `${workspaceId}:${Date.now()}:${Math.random()}`;
  return `deploy-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function workspaceDeployCommand(
  workspaceId: string,
  options?: {
    idempotencyKey?: string;
    runTestsIfPresent?: boolean;
    runBuildIfPresent?: boolean;
    preflightOnly?: boolean;
    autoFix?: boolean;
    pollIntervalMs?: number;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const validation = {
    runBuildIfPresent: options?.runBuildIfPresent ?? true,
    runTestsIfPresent: options?.runTestsIfPresent ?? true,
  };
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1500);
  const autoFixEnabled = Boolean(options?.autoFix);

  const preflight = await preflightWorkspaceDeployment(workerUrl, workspaceId, {
    validation,
    autoFix: {
      rehydrateBaseline: autoFixEnabled,
      bootstrapToolchain: autoFixEnabled,
    },
  });
  const checks = Array.isArray(preflight.preflight.checks) ? preflight.preflight.checks : [];
  const toolchain = preflight.preflight.toolchain ?? null;
  const remediations = Array.isArray(preflight.preflight.remediations)
    ? preflight.preflight.remediations
    : [];
  p.log.message('Preflight checks:');
  for (const check of checks) {
    p.log.message(`- ${check.code}: ${check.ok ? 'ok' : check.details ?? 'failed'}`);
  }
  if (toolchain) {
    p.log.message(
      `Toolchain: ${toolchain.manager}${toolchain.version ? '@' + toolchain.version : ''} (${toolchain.detectedFrom})`
    );
  }
  if (remediations.length > 0) {
    p.log.message('Remediations:');
    for (const remediation of remediations) {
      p.log.message(`- ${remediation.code}: ${remediation.applied ? 'applied' : remediation.details ?? 'not applied'}`);
    }
  }

  if (!preflight.preflight.ok) {
    p.log.error('Workspace deployment preflight failed');
    if (preflight.nextAction) {
      p.log.warning(`Next action: ${preflight.nextAction}`);
    }
    throw new Error('Workspace deploy preflight failed');
  }

  if (options?.preflightOnly) {
    p.log.success('Preflight passed (preflight-only mode)');
    return;
  }

  p.log.success('Preflight passed');
  const idempotencyKey = options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId);
  const created = await createWorkspaceDeployment(workerUrl, workspaceId, idempotencyKey, {
    provider: 'simulated',
    validation,
    autoFix: {
      rehydrateBaseline: autoFixEnabled,
      bootstrapToolchain: autoFixEnabled,
    },
    cache: {
      dependencyCache: true,
    },
    retry: { maxRetries: 2 },
    rollbackOnFailure: true,
    provenance: {
      trigger: 'manual_cli',
      taskId: null,
      operationId: null,
      note: null,
    },
  });

  const deploymentId = created.deployment.id;
  p.log.message(`Deployment queued: ${deploymentId}`);

  while (true) {
    await sleep(pollIntervalMs);
    const current = await getWorkspaceDeployment(workerUrl, workspaceId, deploymentId);
    const status = current.deployment.status;
    p.log.message(`Status: ${status}`);

    if (status === 'queued' || status === 'running') {
      continue;
    }

    if (status === 'succeeded') {
      p.log.success(`Deployed URL: ${current.deployment.deployedUrl ?? '(none)'}`);
      return;
    }

    const error = current.deployment.error;
    if (error) {
      p.log.error(`${error.code}: ${error.message}`);
    }
    if (current.nextAction) {
      p.log.warning(`Next action: ${current.nextAction}`);
    }
    throw new Error(`Workspace deployment ended in non-success status: ${status}`);
  }
}
