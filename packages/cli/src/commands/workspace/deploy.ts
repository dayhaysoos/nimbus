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
import { GitRepo } from '../../lib/checkpoint/git.js';
import type { WorkspaceDeploymentResponse } from '../../lib/types.js';

function buildIdempotencyKey(workspaceId: string): string {
  const seed = `${workspaceId}:${Date.now()}:${Math.random()}`;
  return `deploy-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let resolveEntireIntentContextForCommitFn = resolveEntireIntentContextForCommit;
export function parseRepositorySlugFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = remoteUrl.replace(/^git\+/, '').replace(/\.git$/i, '').trim();
  if (!normalized) {
    return null;
  }

  const scpLikeSshMatch = normalized.match(/^git@([^:]+):([^/]+\/[^/]+)$/i);
  if (scpLikeSshMatch) {
    const host = (scpLikeSshMatch[1] ?? '').toLowerCase();
    if (host !== 'github.com') {
      return null;
    }
    return scpLikeSshMatch[2] ?? null;
  }

  if (/^https?:\/\//i.test(normalized) || /^ssh:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      if (parsed.hostname.toLowerCase() !== 'github.com') {
        return null;
      }
      const segments = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (segments.length < 2) {
        return null;
      }
      return `${segments[0]}/${segments[1]}`;
    } catch {
      return null;
    }
  }

  return null;
}

function resolveRepositorySlugForProvenance(): string | null {
  const explicit = process.env.NIMBUS_REPO_SLUG?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const git = new GitRepo(process.cwd());
    const remoteUrl = git.run(['remote', 'get-url', 'origin']).trim();
    if (!remoteUrl) {
      return null;
    }

    return parseRepositorySlugFromRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

let resolveRepositorySlugForProvenanceFn = resolveRepositorySlugForProvenance;

export function setWorkspaceDeployIntentContextResolverForTests(
  resolver:
    | (typeof resolveEntireIntentContextForCommit)
    | null
): void {
  resolveEntireIntentContextForCommitFn = resolver ?? resolveEntireIntentContextForCommit;
}

export function setWorkspaceDeployRepositorySlugResolverForTests(
  resolver: (() => string | null) | null
): void {
  resolveRepositorySlugForProvenanceFn = resolver ?? resolveRepositorySlugForProvenance;
}

interface WorkspaceDeployReporter {
  message: (text: string) => void;
  success: (text: string) => void;
  warning: (text: string) => void;
  error: (text: string) => void;
}

const DEFAULT_REPORTER: WorkspaceDeployReporter = {
  message: (text) => p.log.message(text),
  success: (text) => p.log.success(text),
  warning: (text) => p.log.warning(text),
  error: (text) => p.log.error(text),
};

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
    reporter?: WorkspaceDeployReporter;
  }
): Promise<WorkspaceDeploymentResponse | null> {
  const reporter = options?.reporter ?? DEFAULT_REPORTER;
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
  reporter.message('Preflight checks:');
  for (const check of checks) {
    reporter.message(`- ${check.code}: ${check.ok ? 'ok' : check.details ?? 'failed'}`);
  }
  if (toolchain) {
    reporter.message(
      `Toolchain: ${toolchain.manager}${toolchain.version ? '@' + toolchain.version : ''} (${toolchain.detectedFrom})`
    );
  }
  if (remediations.length > 0) {
    reporter.message('Remediations:');
    for (const remediation of remediations) {
      reporter.message(`- ${remediation.code}: ${remediation.applied ? 'applied' : remediation.details ?? 'not applied'}`);
    }
  }

  if (!preflight.preflight.ok) {
    reporter.error('Workspace deployment preflight failed');
    const failedCheck = checks.find((check) => !check.ok);
    if (failedCheck?.code === 'git_baseline' && !autoFixEnabled) {
      reporter.warning('Tip: rerun with `--auto-fix` to allow safe baseline rehydrate remediation.');
    }
    if (preflight.nextAction) {
      reporter.warning(`Next action: ${preflight.nextAction}`);
    }
    throw new Error('Workspace deploy preflight failed');
  }

  if (options?.preflightOnly) {
    reporter.success('Preflight passed (preflight-only mode)');
    return null;
  }

  const workspace = await getWorkspace(workerUrl, workspaceId);
  let entireIntentContext;
  if (!workspace.checkpointId) {
    reporter.warning(
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

  reporter.success('Preflight passed');
  const repositorySlug = resolveRepositorySlugForProvenanceFn();
  if (!repositorySlug) {
    throw new Error(
      'Unable to resolve GitHub repository slug for deployment provenance. Set NIMBUS_REPO_SLUG=<owner>/<repo> or configure origin remote to github.com.'
    );
  }
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
      repo: repositorySlug,
    },
  });

  const deploymentId = created.deployment.id;
  reporter.message(`Deployment queued: ${deploymentId}`);

  while (true) {
    await sleep(pollIntervalMs);
    const current = await getWorkspaceDeployment(workerUrl, workspaceId, deploymentId);
    const status = current.deployment.status;
    reporter.message(`Status: ${status}`);

    if (status === 'queued' || status === 'running') {
      continue;
    }

    if (status === 'succeeded') {
      reporter.success(`${current.deployment.provider === 'simulated' ? 'Deployed URL' : 'Live URL'}: ${current.deployment.deployedUrl ?? '(none)'}`);
      if (current.deployment.provider === 'simulated') {
        reporter.message('Note: simulated provider returns a synthetic URL; no live site is published yet.');
      }
      return current.deployment;
    }

    const error = current.deployment.error;
    if (error) {
      reporter.error(`${error.code}: ${error.message}`);
    }
    if (current.nextAction) {
      reporter.warning(`Next action: ${current.nextAction}`);
    }
    throw new Error(`Workspace deployment ended in non-success status: ${status}`);
  }
}
