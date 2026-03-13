import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import {
  createWorkspaceDeployment,
  getWorkspace,
  getWorkerUrl,
  getWorkspaceDeployment,
  preflightWorkspaceDeployment,
} from '../../lib/api.js';
import { resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';

function buildIdempotencyKey(workspaceId: string): string {
  const seed = `${workspaceId}:${Date.now()}:${Math.random()}`;
  return `deploy-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let resolveEntireIntentContextForCommitFn = resolveEntireIntentContextForCommit;

export function setWorkspaceDeployIntentContextResolverForTests(
  resolver:
    | (typeof resolveEntireIntentContextForCommit)
    | null
): void {
  resolveEntireIntentContextForCommitFn = resolver ?? resolveEntireIntentContextForCommit;
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
    provider?: 'simulated' | 'cloudflare_workers_assets';
    outputDir?: string;
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const validation = {
    runBuildIfPresent: options?.runBuildIfPresent ?? false,
    runTestsIfPresent: options?.runTestsIfPresent ?? false,
  };
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1500);
  const autoFixEnabled = Boolean(options?.autoFix);
  const provider = options?.provider;
  const outputDir = options?.outputDir?.trim() || null;

  let preflight;
  try {
    preflight = await preflightWorkspaceDeployment(workerUrl, workspaceId, {
      validation,
      autoFix: {
        rehydrateBaseline: autoFixEnabled,
        bootstrapToolchain: autoFixEnabled,
      },
      provider,
      deploy: {
        outputDir,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Worker error (404)')) {
      let workspaceReachable = false;
      try {
        await getWorkspace(workerUrl, workspaceId);
        workspaceReachable = true;
      } catch {
        workspaceReachable = false;
      }
      if (workspaceReachable) {
        throw new Error(
          'Deploy routes returned 404 while workspace routes are reachable. Redeploy worker from this branch, then run `pnpm run setup:worker`.'
        );
      }
    }
    throw error;
  }
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
    const failedCheck = checks.find((check) => !check.ok);
    if (failedCheck?.code === 'git_baseline' && !autoFixEnabled) {
      p.log.warning('Tip: rerun with `--auto-fix` to allow safe baseline rehydrate remediation.');
    }
    if (preflight.nextAction) {
      p.log.warning(`Next action: ${preflight.nextAction}`);
    }
    throw new Error('Workspace deploy preflight failed');
  }

  if (options?.preflightOnly) {
    p.log.success('Preflight passed (preflight-only mode)');
    return;
  }

  const workspace = await getWorkspace(workerUrl, workspaceId);
  let entireIntentContext;
  if (!workspace.checkpointId) {
    p.log.warning(
      `Workspace ${workspaceId} has no checkpoint ID; proceeding without Entire checkpoint intent context.`
    );
    entireIntentContext = {
      note: null,
      sessionIds: [],
      transcriptUrl: null,
      intentSessionContext: [],
    };
  } else {
    try {
      entireIntentContext = await resolveEntireIntentContextForCommitFn(workspace.commitSha, process.cwd(), {
        summarizeSession: options?.summarizeSession ?? 'auto',
        tokenBudget: options?.intentTokenBudget,
        checkpointId: workspace.checkpointId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to resolve required Entire intent context for checkpoint ${workspace.checkpointId} at commit ${workspace.commitSha.slice(0, 12)}. ${message}`
      );
    }
  }

  p.log.success('Preflight passed');
  const idempotencyKey = options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId);
  const created = await createWorkspaceDeployment(workerUrl, workspaceId, idempotencyKey, {
    provider,
    validation,
    autoFix: {
      rehydrateBaseline: autoFixEnabled,
      bootstrapToolchain: autoFixEnabled,
    },
    cache: {
      dependencyCache: true,
    },
    deploy: {
      outputDir,
    },
    retry: { maxRetries: 2 },
    rollbackOnFailure: true,
    provenance: {
      trigger: 'manual_cli',
      taskId: null,
      operationId: null,
      note: entireIntentContext?.note ?? null,
      sessionIds: entireIntentContext?.sessionIds ?? [],
      transcriptUrl: entireIntentContext?.transcriptUrl ?? null,
      intentSessionContext: entireIntentContext?.intentSessionContext ?? [],
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
      p.log.success(`${current.deployment.provider === 'simulated' ? 'Deployed URL' : 'Live URL'}: ${current.deployment.deployedUrl ?? '(none)'}`);
      if (current.deployment.provider === 'simulated') {
        p.log.message('Note: simulated provider returns a synthetic URL; no live site is published yet.');
      }
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
