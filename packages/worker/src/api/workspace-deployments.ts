import type { Env } from '../types.js';
import { loadRuntimeFlags } from '../lib/flags.js';
import {
  appendWorkspaceDeploymentEvent,
  createWorkspaceDeployment,
  generateWorkspaceDeploymentId,
  getWorkspace,
  getWorkspaceDeployment,
  hasWorkspaceDeploymentEvent,
  listWorkspaceDeploymentEvents,
  WorkspaceDeploymentIdempotencyConflictError,
} from '../lib/db.js';
import { createWorkspaceDeploymentQueueMessage } from '../lib/workspace-deployment-queue.js';
import {
  cancelWorkspaceDeployment,
  runWorkspaceDeploymentInlineWithRetries,
  runWorkspaceDeploymentPreflight,
} from '../lib/workspace-deployment-runner.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function parseInteger(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return fallback;
  }
  const value = Math.floor(input);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function parseBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input !== 'boolean') {
    return fallback;
  }
  return input;
}

function buildDeploymentIdempotencyPayload(requestPayload: {
  provider: string;
  retry: { maxRetries: number };
  validation: { runBuildIfPresent: boolean; runTestsIfPresent: boolean };
  autoFix: { rehydrateBaseline: boolean; bootstrapToolchain: boolean };
  toolchain: { manager: string | null; version: string | null };
  cache: { dependencyCache: boolean };
  rollbackOnFailure: boolean;
  provenance: { trigger: string; taskId: string | null; operationId: string | null; note: string | null };
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    provider: requestPayload.provider,
    retry: requestPayload.retry,
    validation: requestPayload.validation,
    rollbackOnFailure: requestPayload.rollbackOnFailure,
    provenance: requestPayload.provenance,
  };

  if (requestPayload.autoFix.rehydrateBaseline || requestPayload.autoFix.bootstrapToolchain) {
    payload.autoFix = requestPayload.autoFix;
  }

  if (requestPayload.toolchain.manager || requestPayload.toolchain.version) {
    payload.toolchain = requestPayload.toolchain;
  }

  if (!requestPayload.cache.dependencyCache) {
    payload.cache = requestPayload.cache;
  }

  return payload;
}

function nextActionForDeploymentError(code: string | undefined): string | null {
  switch (code) {
    case 'toolchain_detect_failed':
      return 'Verify package.json and lockfile metadata, then retry deploy.';
    case 'corepack_missing':
      return 'Use a sandbox image with corepack available, or switch to npm toolchain.';
    case 'package_manager_bootstrap_failed':
      return 'Confirm the requested package manager version is valid and retry deploy.';
    case 'validation_tool_missing':
      return 'Disable build/test validation for this deploy or install required tooling in the sandbox image.';
    case 'validation_command_failed':
      return 'Review test/build output, fix project errors, and retry deploy.';
    case 'invalid_project_root':
      return 'Set workspace source project root to a safe relative path and retry deploy.';
    case 'baseline_missing':
    case 'baseline_rehydrate_failed':
      return 'Reset the workspace and retry deploy to rebuild git baseline.';
    case 'potential_secrets_detected':
      return 'Remove sensitive files from workspace before deploying (template files like .env.example are allowed).';
    default:
      return null;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureWorkspaceReady(env: Env, workspaceId: string): Promise<Response | null> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  if (workspace.status !== 'ready') {
    return jsonResponse(
      {
        error: 'Workspace is not ready',
        workspace: {
          id: workspace.id,
          status: workspace.status,
          errorCode: workspace.errorCode,
          errorMessage: workspace.errorMessage,
        },
      },
      409
    );
  }
  return null;
}

async function ensureWorkspaceExists(env: Env, workspaceId: string): Promise<Response | null> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

async function ensureWorkspaceDeployEnabled(env: Env): Promise<Response | null> {
  const flags = await loadRuntimeFlags(env);
  if (!flags.workspaceDeployEnabled) {
    return jsonResponse(
      {
        error: 'Workspace deploy is disabled',
        code: 'workspace_deploy_disabled',
      },
      403
    );
  }
  return null;
}

export async function handleCreateWorkspaceDeployment(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  try {
    const enabled = await ensureWorkspaceDeployEnabled(env);
    if (enabled) {
      return enabled;
    }

    const workspaceCheck = await ensureWorkspaceReady(env, workspaceId);
    if (workspaceCheck) {
      return workspaceCheck;
    }

    if (!env.WORKSPACE_DEPLOYS_QUEUE && !ctx) {
      return jsonResponse(
        {
          error: 'Workspace deployment runner is unavailable',
          code: 'workspace_deploy_runner_unavailable',
        },
        503
      );
    }

    const idempotencyKey = (request.headers.get('Idempotency-Key') ?? '').trim();
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }

    const payloadRaw = await request.text();
    let payload: Record<string, unknown> = {};
    if (payloadRaw.trim()) {
      const parsed = JSON.parse(payloadRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
      }
      payload = parsed as Record<string, unknown>;
    }

    const provider = typeof payload.provider === 'string' && payload.provider.trim() ? payload.provider.trim() : 'simulated';
    if (provider !== 'simulated') {
      return jsonResponse(
        {
          error: 'Unsupported deployment provider',
          code: 'unsupported_deploy_provider',
          allowedProviders: ['simulated'],
        },
        400
      );
    }
    const retry =
      payload.retry && typeof payload.retry === 'object' && !Array.isArray(payload.retry)
        ? (payload.retry as Record<string, unknown>)
        : {};
    const validation =
      payload.validation && typeof payload.validation === 'object' && !Array.isArray(payload.validation)
        ? (payload.validation as Record<string, unknown>)
        : {};
    const provenance =
      payload.provenance && typeof payload.provenance === 'object' && !Array.isArray(payload.provenance)
        ? (payload.provenance as Record<string, unknown>)
        : {};
    const autoFix =
      payload.autoFix && typeof payload.autoFix === 'object' && !Array.isArray(payload.autoFix)
        ? (payload.autoFix as Record<string, unknown>)
        : {};
    const toolchain =
      payload.toolchain && typeof payload.toolchain === 'object' && !Array.isArray(payload.toolchain)
        ? (payload.toolchain as Record<string, unknown>)
        : {};
    const cache =
      payload.cache && typeof payload.cache === 'object' && !Array.isArray(payload.cache)
        ? (payload.cache as Record<string, unknown>)
        : {};
    const maxRetries = parseInteger(retry.maxRetries, 2, 0, 5);

    const requestPayload = {
      provider,
      retry: {
        maxRetries,
      },
      validation: {
        runBuildIfPresent: parseBoolean(validation.runBuildIfPresent, true),
        runTestsIfPresent: parseBoolean(validation.runTestsIfPresent, true),
      },
      autoFix: {
        rehydrateBaseline: parseBoolean(autoFix.rehydrateBaseline, false),
        bootstrapToolchain: parseBoolean(autoFix.bootstrapToolchain, false),
      },
      toolchain: {
        manager: typeof toolchain.manager === 'string' && toolchain.manager.trim() ? toolchain.manager.trim() : null,
        version: typeof toolchain.version === 'string' && toolchain.version.trim() ? toolchain.version.trim() : null,
      },
      cache: {
        dependencyCache: parseBoolean(cache.dependencyCache, true),
      },
      rollbackOnFailure: parseBoolean(payload.rollbackOnFailure, true),
      provenance: {
        trigger: typeof provenance.trigger === 'string' && provenance.trigger.trim() ? provenance.trigger.trim() : 'manual',
        taskId: typeof provenance.taskId === 'string' && provenance.taskId.trim() ? provenance.taskId.trim() : null,
        operationId:
          typeof provenance.operationId === 'string' && provenance.operationId.trim() ? provenance.operationId.trim() : null,
        note: typeof provenance.note === 'string' && provenance.note.trim() ? provenance.note.trim() : null,
      },
    };

    const requestPayloadSha256 = await sha256Hex(
      JSON.stringify(buildDeploymentIdempotencyPayload(requestPayload))
    );
    const created = await createWorkspaceDeployment(env.DB, {
      id: generateWorkspaceDeploymentId(),
      workspaceId,
      provider,
      idempotencyKey,
      requestPayload,
      requestPayloadSha256,
      maxRetries,
      provenance: requestPayload.provenance,
    });

    if (!created.reused) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId: created.deployment.id,
        eventType: 'deployment_created',
        payload: {
          provider,
          maxRetries,
          provenance: requestPayload.provenance,
        },
      });
    }

    if (created.deployment.status === 'queued') {
      const hasEnqueuedEvent = await hasWorkspaceDeploymentEvent(
        env.DB,
        workspaceId,
        created.deployment.id,
        'deployment_enqueued'
      );
      const shouldRecoverQueued = created.reused && created.deployment.error?.code === 'retry_scheduled';
      const hasRecoveredReenqueue = shouldRecoverQueued
        ? await hasWorkspaceDeploymentEvent(env.DB, workspaceId, created.deployment.id, 'deployment_reenqueue_recovered')
        : false;

      if (!hasEnqueuedEvent || (shouldRecoverQueued && !hasRecoveredReenqueue)) {
        if (env.WORKSPACE_DEPLOYS_QUEUE) {
          await env.WORKSPACE_DEPLOYS_QUEUE.send(
            createWorkspaceDeploymentQueueMessage(workspaceId, created.deployment.id)
          );
        } else if (ctx) {
          ctx.waitUntil(
            runWorkspaceDeploymentInlineWithRetries(env, workspaceId, created.deployment.id, created.deployment.maxRetries + 1)
          );
        }

        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId: created.deployment.id,
          eventType: 'deployment_enqueued',
          payload: {
            mode: env.WORKSPACE_DEPLOYS_QUEUE ? 'queue' : 'inline',
            reused: created.reused,
          },
        });

        if (shouldRecoverQueued && !hasRecoveredReenqueue) {
          await appendWorkspaceDeploymentEvent(env.DB, {
            workspaceId,
            deploymentId: created.deployment.id,
            eventType: 'deployment_reenqueue_recovered',
            payload: {
              reason: 'retry_scheduled_replay',
            },
          });
        }
      }
    }

    return jsonResponse({ deployment: created.deployment }, created.reused ? 200 : 202);
  } catch (error) {
    if (error instanceof WorkspaceDeploymentIdempotencyConflictError) {
      return jsonResponse(
        {
          error: 'Idempotency key has already been used with different payload',
          code: 'idempotency_key_conflict',
        },
        409
      );
    }

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create workspace deployment: ${message}` }, 500);
  }
}

export async function handleWorkspaceDeploymentPreflight(
  workspaceId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const enabled = await ensureWorkspaceDeployEnabled(env);
  if (enabled) {
    return enabled;
  }

  const workspaceCheck = await ensureWorkspaceReady(env, workspaceId);
  if (workspaceCheck) {
    return workspaceCheck;
  }

  let payload: Record<string, unknown> = {};
  try {
    const raw = await request.text();
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
      }
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const validation =
    payload.validation && typeof payload.validation === 'object' && !Array.isArray(payload.validation)
      ? (payload.validation as Record<string, unknown>)
      : {};
  const autoFix =
    payload.autoFix && typeof payload.autoFix === 'object' && !Array.isArray(payload.autoFix)
      ? (payload.autoFix as Record<string, unknown>)
      : {};
  const runBuildIfPresent = parseBoolean(validation.runBuildIfPresent, true);
  const runTestsIfPresent = parseBoolean(validation.runTestsIfPresent, true);
  const rehydrateBaseline = parseBoolean(autoFix.rehydrateBaseline, false);
  const bootstrapToolchain = parseBoolean(autoFix.bootstrapToolchain, false);

  try {
    const preflight = await runWorkspaceDeploymentPreflight(env, workspaceId, {
      runBuildIfPresent,
      runTestsIfPresent,
      rehydrateBaseline,
      bootstrapToolchain,
    });
    const failedCheck = preflight.checks.find((check) => !check.ok);
    const nextAction = failedCheck
      ? failedCheck.code === 'validation_tooling'
        ? 'Disable build/test validation or install the detected package manager in the sandbox runtime image.'
        : failedCheck.code === 'git_baseline'
          ? 'Reset workspace to rebuild git baseline and retry deploy.'
          : failedCheck.code === 'secret_scan'
            ? 'Remove sensitive files from workspace before deploying.'
            : failedCheck.code === 'toolchain_detect'
              ? 'Fix package.json/lockfile metadata and retry preflight.'
              : failedCheck.code === 'toolchain_bootstrap'
                ? 'Enable auto-fix bootstrap or use a sandbox image with corepack support.'
                : failedCheck.code === 'project_root'
                  ? 'Set workspace source project root to a safe relative path and retry preflight.'
            : null
      : null;
    return jsonResponse({ preflight, nextAction });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        preflight: {
          ok: false,
          toolchain: null,
          checks: [{ code: 'internal_error', ok: false, details: message }],
          remediations: [],
        },
      },
      500
    );
  }
}

export async function handleGetWorkspaceDeployment(
  workspaceId: string,
  deploymentId: string,
  env: Env
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }

  return jsonResponse({
    deployment,
    nextAction: nextActionForDeploymentError(deployment.error?.code),
  });
}

export async function handleGetWorkspaceDeploymentEvents(
  workspaceId: string,
  deploymentId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }

  const url = new URL(request.url);
  const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '500', 10);
  const fromExclusive = Number.isFinite(from) && from > 0 ? from : 0;
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 500;

  const events = await listWorkspaceDeploymentEvents(env.DB, workspaceId, deploymentId, fromExclusive, boundedLimit);
  return jsonResponse({ deploymentId, events });
}

export async function handleCancelWorkspaceDeployment(
  workspaceId: string,
  deploymentId: string,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const cancelResult = await cancelWorkspaceDeployment(env, workspaceId, deploymentId);
  if (!cancelResult.deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }

  if (cancelResult.updated) {
    if (
      !env.WORKSPACE_DEPLOYS_QUEUE &&
      ctx &&
      cancelResult.deployment?.status === 'running' &&
      cancelResult.deployment.cancelRequestedAt
    ) {
      ctx.waitUntil(runWorkspaceDeploymentInlineWithRetries(env, workspaceId, deploymentId, 2));
    }

    return jsonResponse({ deployment: cancelResult.deployment }, 202);
  }

  if (cancelResult.deployment.status === 'running' && cancelResult.deployment.cancelRequestedAt) {
    return jsonResponse({ deployment: cancelResult.deployment }, 202);
  }

  return jsonResponse(
    {
      error: 'Deployment is already terminal and cannot be cancelled',
      code: 'deployment_not_cancellable',
      deployment: cancelResult.deployment,
    },
    409
  );
}
