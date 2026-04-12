import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import {
  createWorkspaceDeployment,
  getWorkspaceDeployment,
  preflightWorkspaceDeployment,
} from '../../clients/worker/deployments.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { getWorkspace } from '../../clients/worker/workspaces.js';
import { resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import type { WorkspaceDeploymentResponse } from '../../lib/types.js';
import type { ReviewEntireContextResolution } from '../../commands/review/preflight.js';

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

interface DeployIntentContext {
  note: string | null;
  sessionIds: string[];
  transcriptUrl: string | null;
  intentSessionContext: string[];
  rawSessionPrompts?: string | null;
}

interface DeployRequestPayload {
  provider?: 'simulated' | 'cloudflare_workers_assets';
  validation: {
    runBuildIfPresent: boolean;
    runTestsIfPresent: boolean;
  };
  autoFix: {
    rehydrateBaseline: boolean;
    bootstrapToolchain: boolean;
  };
  cache: {
    dependencyCache: boolean;
  };
  deploy: {
    outputDir: string | null;
  };
  retry: {
    maxRetries: number;
  };
  rollbackOnFailure: boolean;
  provenance: {
    trigger: string;
    taskId: string | null;
    operationId: string | null;
    note: string | null;
      repo: string;
      deployProvider?: 'simulated' | 'cloudflare_workers_assets' | null;
      deployOutputDir?: string | null;
      sessionIds?: string[];
      transcriptUrl?: string | null;
    intentSessionContext?: string[];
    rawSessionPrompts?: string | null;
    contextResolution?: 'direct' | 'branch_fallback';
    contextResolutionOriginalCheckpointId?: string;
    contextResolutionResolvedCheckpointId?: string;
    contextResolutionResolvedCommitSha?: string;
    contextResolutionResolvedCommitMessage?: string;
  };
}

function readProvenanceString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function isFallbackReusableDeploymentCompatible(
  deployment: WorkspaceDeploymentResponse,
  request: { provider?: 'simulated' | 'cloudflare_workers_assets'; outputDir: string | null }
): { ok: boolean; reason?: string } {
  if (request.provider && deployment.provider !== request.provider) {
    return {
      ok: false,
      reason: `provider mismatch (requested ${request.provider}, existing ${deployment.provider})`,
    };
  }

  if (request.outputDir !== null) {
    const deployOutputDir = readProvenanceString(deployment.provenance, 'deployOutputDir');
    if (deployOutputDir === null || deployOutputDir !== request.outputDir) {
      return {
        ok: false,
        reason: 'outputDir mismatch or unavailable on existing deployment provenance',
      };
    }
  }

  return { ok: true };
}

function buildRetryIdempotencyKey(baseIdempotencyKey: string): string {
  const seed = `${baseIdempotencyKey}:retry:${Date.now()}:${Math.random()}`;
  return `deploy-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function isFailedReusableDeploymentStatus(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'cancelled';
}

async function createWorkspaceDeploymentWithFreshRetryOnFailedReuse(
  workerUrl: string,
  workspaceId: string,
  idempotencyKey: string,
  payload: DeployRequestPayload,
  reporter: WorkspaceDeployReporter
) {
  const created = await createWorkspaceDeployment(workerUrl, workspaceId, idempotencyKey, payload);
  if (!created.reused || !isFailedReusableDeploymentStatus(created.deployment.status)) {
    return created;
  }

  reporter.warning(
    `Reused deployment ${created.deployment.id} is ${created.deployment.status}; creating a fresh deployment attempt.`
  );
  const retryIdempotencyKey = buildRetryIdempotencyKey(idempotencyKey);
  return createWorkspaceDeployment(workerUrl, workspaceId, retryIdempotencyKey, payload);
}

const DEFAULT_REPORTER: WorkspaceDeployReporter = {
  message: (text) => p.log.message(text),
  success: (text) => p.log.success(text),
  warning: (text) => p.log.warning(text),
  error: (text) => p.log.error(text),
};

function buildEmptyDeployIntentContext(): DeployIntentContext {
  return {
    note: null,
    sessionIds: [],
    transcriptUrl: null,
    intentSessionContext: [],
    rawSessionPrompts: null,
  };
}

function buildWorkspaceDeployCreatePayload(input: {
  provider?: 'simulated' | 'cloudflare_workers_assets';
  validation: {
    runBuildIfPresent: boolean;
    runTestsIfPresent: boolean;
  };
  autoFixEnabled: boolean;
  outputDir: string | null;
  repositorySlug: string;
  entireIntentContext: DeployIntentContext;
  contextOverride?: ReviewEntireContextResolution;
}): DeployRequestPayload {
  return {
    provider: input.provider,
    validation: input.validation,
    autoFix: {
      rehydrateBaseline: input.autoFixEnabled,
      bootstrapToolchain: input.autoFixEnabled,
    },
    cache: {
      dependencyCache: true,
    },
    deploy: {
      outputDir: input.outputDir,
    },
    retry: { maxRetries: 2 },
    rollbackOnFailure: true,
      provenance: {
      trigger: 'manual_cli',
      taskId: null,
      operationId: null,
      note: input.entireIntentContext?.note ?? null,
      sessionIds: input.entireIntentContext?.sessionIds ?? [],
      transcriptUrl: input.entireIntentContext?.transcriptUrl ?? null,
      intentSessionContext: input.entireIntentContext?.intentSessionContext ?? [],
        rawSessionPrompts: input.entireIntentContext?.rawSessionPrompts ?? null,
        repo: input.repositorySlug,
        deployProvider: input.provider ?? null,
        deployOutputDir: input.outputDir,
        contextResolution: input.contextOverride?.contextResolution,
        contextResolutionOriginalCheckpointId: input.contextOverride?.originalCheckpointId,
        contextResolutionResolvedCheckpointId: input.contextOverride?.resolvedCheckpointId,
      contextResolutionResolvedCommitSha: input.contextOverride?.resolvedCommitSha,
      contextResolutionResolvedCommitMessage: input.contextOverride?.resolvedCommitSubject,
    },
  };
}

async function isWorkspaceRouteReachable(workerUrl: string, workspaceId: string): Promise<boolean> {
  try {
    await getWorkspace(workerUrl, workspaceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves Entire intent context used for deployment provenance.
 * Explicit overrides win; otherwise checkpoint-backed context is required when the workspace has a checkpoint.
 */
async function resolveDeployIntentContext(
  workspace: Awaited<ReturnType<typeof getWorkspace>>,
  reporter: WorkspaceDeployReporter,
  options?: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
    entireIntentContextOverride?: ReviewEntireContextResolution;
  }
): Promise<DeployIntentContext> {
  const contextOverride = options?.entireIntentContextOverride;
  if (contextOverride) {
    return contextOverride.context;
  }

  if (!workspace.checkpointId) {
    reporter.warning(
      `Workspace ${workspace.id} has no checkpoint ID; proceeding without Entire checkpoint intent context.`
    );
    return buildEmptyDeployIntentContext();
  }

  try {
    return await resolveEntireIntentContextForCommitFn(workspace.commitSha, process.cwd(), {
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
    entireIntentContextOverride?: ReviewEntireContextResolution;
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
  const idempotencyKey = options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId);

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
      const workspaceReachable = await isWorkspaceRouteReachable(workerUrl, workspaceId);
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
    if (!options?.preflightOnly && failedCheck?.code === 'git_baseline') {
      reporter.message('Attempting to reuse an existing deployment for this review base...');
      const workspace = await getWorkspace(workerUrl, workspaceId);
      if (workspace.lastDeploymentId) {
        const existing = await getWorkspaceDeployment(workerUrl, workspaceId, workspace.lastDeploymentId);
        const compatibility = isFallbackReusableDeploymentCompatible(existing.deployment, {
          provider,
          outputDir,
        });
        if (existing.deployment.status === 'succeeded' && compatibility.ok) {
          reporter.success(`Reused existing deployment: ${existing.deployment.id}`);
          reporter.success(
            `${existing.deployment.provider === 'simulated' ? 'Deployed URL' : 'Live URL'}: ${existing.deployment.deployedUrl ?? '(none)'}`
          );
          if (existing.deployment.provider === 'simulated') {
            reporter.message('Note: simulated provider returns a synthetic URL; no live site is published yet.');
          }
          return existing.deployment;
        }

        if (existing.deployment.status !== 'succeeded') {
          reporter.warning(
            `Latest deployment ${existing.deployment.id} is ${existing.deployment.status}; cannot reuse it for preflight fallback.`
          );
        } else {
          reporter.warning(
            `Latest deployment ${existing.deployment.id} is incompatible with current request (${compatibility.reason ?? 'unknown'}).`
          );
        }
      } else {
        reporter.warning('No existing deployment found to reuse for preflight fallback.');
      }
    }
    throw new Error('Workspace deploy preflight failed');
  }

  if (options?.preflightOnly) {
    reporter.success('Preflight passed (preflight-only mode)');
    return null;
  }

  const workspace = await getWorkspace(workerUrl, workspaceId);
  const contextOverride = options?.entireIntentContextOverride;
  const entireIntentContext = await resolveDeployIntentContext(workspace, reporter, {
    summarizeSession: options?.summarizeSession,
    intentTokenBudget: options?.intentTokenBudget,
    entireIntentContextOverride: contextOverride,
  });

  reporter.success('Preflight passed');
  const repositorySlug = resolveRepositorySlugForProvenanceFn();
  if (!repositorySlug) {
    throw new Error(
      'Unable to resolve GitHub repository slug for deployment provenance. Set NIMBUS_REPO_SLUG=<owner>/<repo> or configure origin remote to github.com.'
    );
  }
  const created = await createWorkspaceDeploymentWithFreshRetryOnFailedReuse(
    workerUrl,
    workspaceId,
    idempotencyKey,
    buildWorkspaceDeployCreatePayload({
      provider,
      validation,
      autoFixEnabled,
      outputDir,
      repositorySlug,
      entireIntentContext,
      contextOverride,
    }),
    reporter
  );

  const deploymentId = created.deployment.id;
  reporter.message(`${created.reused ? 'Reusing deployment' : 'Deployment queued'}: ${deploymentId}`);

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
