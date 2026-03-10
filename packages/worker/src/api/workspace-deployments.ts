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
  updateWorkspaceDeploymentSummary,
  WorkspaceDeploymentIdempotencyConflictError,
} from '../lib/db.js';
import { createWorkspaceDeploymentQueueMessage } from '../lib/workspace-deployment-queue.js';
import {
  cancelWorkspaceDeployment,
  runWorkspaceDeploymentInlineWithRetries,
  runWorkspaceDeploymentPreflight,
} from '../lib/workspace-deployment-runner.js';
import {
  createWorkspaceDeployProvider,
  getWorkspaceDeployProviderConfigError,
  getWorkspaceDeployProviderName,
  normalizeProviderError,
} from '../lib/workspace-deploy-provider.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

const PROVIDER_PRECHECK_LEASE_MS = 30_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function deploymentCreateResponseStatus(reused: boolean): number {
  return reused ? 200 : 202;
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

function isSafeRelativeOutputDir(input: string): boolean {
  if (!input || input === '.') {
    return false;
  }
  if (input.startsWith('/') || input.includes('\\')) {
    return false;
  }
  return input.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function parseDeployOutputDir(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed || null;
}

function buildDeploymentIdempotencyPayload(requestPayload: {
  provider: string;
  retry: { maxRetries: number };
  validation: { runBuildIfPresent: boolean; runTestsIfPresent: boolean };
  autoFix: { rehydrateBaseline: boolean; bootstrapToolchain: boolean };
  toolchain: { manager: string | null; version: string | null };
  cache: { dependencyCache: boolean };
  deploy: { outputDir: string | null };
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

  if (requestPayload.deploy.outputDir) {
    payload.deploy = requestPayload.deploy;
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
    case 'provider_auth_failed':
      return 'Verify CF_ACCOUNT_ID and CF_API_TOKEN, then rerun preflight.';
    case 'provider_scope_missing':
      return 'Grant Workers Scripts/Routes edit scope to CF_API_TOKEN and rerun preflight.';
    case 'provider_project_not_found':
      return 'Set WORKSPACE_DEPLOY_PROJECT_NAME to an existing Workers project and retry.';
    case 'provider_rate_limited':
      return 'Retry deploy after Cloudflare rate limits reset.';
    case 'provider_invalid_output_dir':
      return 'Set deploy.outputDir to a valid static build directory (for example dist or out) and retry.';
    case 'provider_deploy_failed':
      return 'Check provider deployment logs and retry after fixing configuration or build output.';
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

    const providerInput = typeof payload.provider === 'string' ? payload.provider.trim() : '';
    const providerConfigError = getWorkspaceDeployProviderConfigError(env);
    if (!providerInput && providerConfigError) {
      return jsonResponse(
        {
          error: providerConfigError,
          code: 'provider_config_invalid',
        },
        400
      );
    }
    if (providerInput && providerInput !== 'simulated' && providerInput !== 'cloudflare_workers_assets') {
      return jsonResponse(
        {
          error: 'Unsupported deployment provider',
          code: 'unsupported_deploy_provider',
          allowedProviders: ['simulated', 'cloudflare_workers_assets'],
        },
        400
      );
    }
    const provider = getWorkspaceDeployProviderName(providerInput || undefined, env);
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
    const deploy =
      payload.deploy && typeof payload.deploy === 'object' && !Array.isArray(payload.deploy)
        ? (payload.deploy as Record<string, unknown>)
        : {};
    const maxRetries = parseInteger(retry.maxRetries, 2, 0, 5);
    const outputDir = parseDeployOutputDir(deploy.outputDir);

    if (provider === 'cloudflare_workers_assets' && (!outputDir || !isSafeRelativeOutputDir(outputDir))) {
      return jsonResponse(
        {
          error: 'deploy.outputDir is required for cloudflare_workers_assets provider and must be a safe relative directory',
          code: 'provider_invalid_output_dir',
        },
        400
      );
    }

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
      deploy: {
        outputDir,
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

    if (provider === 'cloudflare_workers_assets' && created.deployment.status === 'queued') {
      const hasPrecheckPassed = await hasWorkspaceDeploymentEvent(
        env.DB,
        workspaceId,
        created.deployment.id,
        'deployment_provider_precheck_passed'
      );
      const hasPrecheckFailed = await hasWorkspaceDeploymentEvent(
        env.DB,
        workspaceId,
        created.deployment.id,
        'deployment_provider_precheck_failed'
      );
      const alreadyEnqueued = await hasWorkspaceDeploymentEvent(
        env.DB,
        workspaceId,
        created.deployment.id,
        'deployment_enqueued'
      );

      if (hasPrecheckFailed) {
        return jsonResponse(
          {
            error: created.deployment.error?.message ?? 'Provider precheck previously failed',
            code: created.deployment.error?.code ?? 'provider_deploy_failed',
          },
          400
        );
      }

      if (!hasPrecheckPassed && !alreadyEnqueued) {
        const claimTime = new Date().toISOString();
        const precheckLeaseCutoff = new Date(Date.now() - PROVIDER_PRECHECK_LEASE_MS).toISOString();
        const claimed = await env.DB
          .prepare(
            `UPDATE workspace_deployments
             SET error_code = 'provider_precheck_running',
                 error_message = 'Provider precheck in progress',
                 updated_at = ?
             WHERE id = ?
               AND workspace_id = ?
               AND status = 'queued'
               AND (
                 error_code IS NULL
                 OR error_code = 'retry_scheduled'
                 OR (error_code = 'provider_precheck_running' AND updated_at <= ?)
               )`
          )
          .bind(claimTime, created.deployment.id, workspaceId, precheckLeaseCutoff)
          .run();

        if ((claimed.meta?.changes ?? 0) === 0) {
          const concurrent = await getWorkspaceDeployment(env.DB, workspaceId, created.deployment.id);
          if (concurrent) {
            return jsonResponse({ deployment: concurrent }, deploymentCreateResponseStatus(true));
          }
        }

        let precheckChecks: Array<{ code: string; ok: boolean; details?: string }>;
        try {
          precheckChecks = await createWorkspaceDeployProvider(provider, env).precheck();
        } catch (error) {
          const providerError = normalizeProviderError(error);
          const now = new Date().toISOString();
          const failedUpdate = await env.DB
            .prepare(
              `UPDATE workspace_deployments
               SET status = 'failed',
                   error_code = ?,
                   error_message = ?,
                   finished_at = COALESCE(finished_at, ?),
                   updated_at = ?
               WHERE id = ?
                 AND workspace_id = ?
                 AND status = 'queued'
                 AND error_code = 'provider_precheck_running'
                 AND updated_at = ?`
            )
            .bind(providerError.code, providerError.message, now, now, created.deployment.id, workspaceId, claimTime)
            .run();

          if ((failedUpdate.meta?.changes ?? 0) > 0) {
            await appendWorkspaceDeploymentEvent(env.DB, {
              workspaceId,
              deploymentId: created.deployment.id,
              eventType: 'deployment_provider_precheck_failed',
              payload: {
                code: providerError.code,
                message: providerError.message,
              },
            });
            await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
              deploymentId: created.deployment.id,
              status: 'failed',
              errorCode: providerError.code,
              errorMessage: providerError.message,
            });
            return jsonResponse({ error: providerError.message, code: providerError.code }, 400);
          }

          const concurrent = await getWorkspaceDeployment(env.DB, workspaceId, created.deployment.id);
          if (concurrent) {
            return jsonResponse({ deployment: concurrent }, deploymentCreateResponseStatus(true));
          }

          throw error;
        }

        const failed = precheckChecks.find((check) => !check.ok);
        if (failed) {
          const failureMessage = failed.details ?? 'Provider precheck failed';
          const now = new Date().toISOString();
          const failedUpdate = await env.DB
            .prepare(
              `UPDATE workspace_deployments
               SET status = 'failed',
                   error_code = ?,
                   error_message = ?,
                   finished_at = COALESCE(finished_at, ?),
                   updated_at = ?
               WHERE id = ?
                 AND workspace_id = ?
                 AND status = 'queued'
                 AND error_code = 'provider_precheck_running'
                 AND updated_at = ?`
            )
            .bind(failed.code, failureMessage, now, now, created.deployment.id, workspaceId, claimTime)
            .run();

          if ((failedUpdate.meta?.changes ?? 0) > 0) {
            await appendWorkspaceDeploymentEvent(env.DB, {
              workspaceId,
              deploymentId: created.deployment.id,
              eventType: 'deployment_provider_precheck_failed',
              payload: {
                code: failed.code,
                message: failureMessage,
              },
            });
            await updateWorkspaceDeploymentSummary(env.DB, workspaceId, {
              deploymentId: created.deployment.id,
              status: 'failed',
              errorCode: failed.code,
              errorMessage: failureMessage,
            });
            return jsonResponse({ error: failureMessage, code: failed.code }, 400);
          }

          const concurrent = await getWorkspaceDeployment(env.DB, workspaceId, created.deployment.id);
          if (concurrent) {
            return jsonResponse({ deployment: concurrent }, deploymentCreateResponseStatus(true));
          }

          throw new Error('Provider precheck failed but deployment record was not available for response');
        }

        const clearClaim = await env.DB
          .prepare(
            `UPDATE workspace_deployments
             SET error_code = NULL,
                 error_message = NULL,
                 updated_at = ?
             WHERE id = ?
               AND workspace_id = ?
               AND status = 'queued'
               AND error_code = 'provider_precheck_running'
               AND updated_at = ?`
          )
          .bind(new Date().toISOString(), created.deployment.id, workspaceId, claimTime)
          .run();

        if ((clearClaim.meta?.changes ?? 0) === 0) {
          const concurrent = await getWorkspaceDeployment(env.DB, workspaceId, created.deployment.id);
          if (concurrent) {
            return jsonResponse({ deployment: concurrent }, deploymentCreateResponseStatus(true));
          }
        }

        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId: created.deployment.id,
          eventType: 'deployment_provider_precheck_passed',
          payload: {
            checks: precheckChecks,
          },
        });
      }
    }

    const latestDeployment = await getWorkspaceDeployment(env.DB, workspaceId, created.deployment.id);
    const deploymentForQueue = latestDeployment ?? created.deployment;

    if (deploymentForQueue.status === 'queued') {
      const hasEnqueuedEvent = await hasWorkspaceDeploymentEvent(
        env.DB,
        workspaceId,
        deploymentForQueue.id,
        'deployment_enqueued'
      );
      const shouldRecoverQueued = created.reused && deploymentForQueue.error?.code === 'retry_scheduled';
      const hasRecoveredReenqueue = shouldRecoverQueued
        ? await hasWorkspaceDeploymentEvent(env.DB, workspaceId, deploymentForQueue.id, 'deployment_reenqueue_recovered')
        : false;

      if (!hasEnqueuedEvent || (shouldRecoverQueued && !hasRecoveredReenqueue)) {
        if (env.WORKSPACE_DEPLOYS_QUEUE) {
          await env.WORKSPACE_DEPLOYS_QUEUE.send(
            createWorkspaceDeploymentQueueMessage(workspaceId, deploymentForQueue.id)
          );
        } else if (ctx) {
          ctx.waitUntil(
            runWorkspaceDeploymentInlineWithRetries(env, workspaceId, deploymentForQueue.id, deploymentForQueue.maxRetries + 1)
          );
        }

        await appendWorkspaceDeploymentEvent(env.DB, {
          workspaceId,
          deploymentId: deploymentForQueue.id,
          eventType: 'deployment_enqueued',
          payload: {
            mode: env.WORKSPACE_DEPLOYS_QUEUE ? 'queue' : 'inline',
            reused: created.reused,
          },
        });

        if (shouldRecoverQueued && !hasRecoveredReenqueue) {
          await appendWorkspaceDeploymentEvent(env.DB, {
            workspaceId,
            deploymentId: deploymentForQueue.id,
            eventType: 'deployment_reenqueue_recovered',
            payload: {
              reason: 'retry_scheduled_replay',
            },
          });
        }
      }
    }

    const responseStatus = deploymentCreateResponseStatus(created.reused);
    return jsonResponse({ deployment: deploymentForQueue }, responseStatus);
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
  const deploy =
    payload.deploy && typeof payload.deploy === 'object' && !Array.isArray(payload.deploy)
      ? (payload.deploy as Record<string, unknown>)
      : {};
  const providerInput = typeof payload.provider === 'string' ? payload.provider.trim() : '';
  const providerConfigError = getWorkspaceDeployProviderConfigError(env);
  if (!providerInput && providerConfigError) {
    return jsonResponse(
      {
        preflight: {
          ok: false,
          toolchain: null,
          checks: [{ code: 'provider_config_invalid', ok: false, details: providerConfigError }],
          remediations: [],
        },
        nextAction: 'Set WORKSPACE_DEPLOY_PROVIDER to simulated or cloudflare_workers_assets and retry preflight.',
      },
      200
    );
  }
  if (providerInput && providerInput !== 'simulated' && providerInput !== 'cloudflare_workers_assets') {
    return jsonResponse(
      {
        preflight: {
          ok: false,
          toolchain: null,
          checks: [{ code: 'unsupported_deploy_provider', ok: false, details: `Unsupported provider: ${providerInput}` }],
          remediations: [],
        },
        nextAction: 'Use provider=cloudflare_workers_assets or provider=simulated.',
      },
      200
    );
  }
  const provider = getWorkspaceDeployProviderName(providerInput || undefined, env);
  const outputDir = parseDeployOutputDir(deploy.outputDir);

  if (provider === 'cloudflare_workers_assets' && (!outputDir || !isSafeRelativeOutputDir(outputDir))) {
    return jsonResponse(
      {
        preflight: {
          ok: false,
          toolchain: null,
          checks: [
            {
              code: 'provider_invalid_output_dir',
              ok: false,
              details: 'deploy.outputDir is required and must be a safe relative directory',
            },
          ],
          remediations: [],
        },
        nextAction: 'Set deploy.outputDir to your static build output directory and retry preflight.',
      },
      200
    );
  }
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
      provider,
      outputDir,
    });

    if (provider === 'cloudflare_workers_assets') {
      try {
        const providerChecks = await createWorkspaceDeployProvider(provider, env).precheck();
        preflight.checks.push(...providerChecks);
      } catch (error) {
        const providerError = normalizeProviderError(error);
        preflight.checks.push({ code: providerError.code, ok: false, details: providerError.message });
      }
      preflight.ok = preflight.checks.every((check) => check.ok);
    }

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
                  : failedCheck.code === 'provider_invalid_output_dir'
                    ? 'Set deploy.outputDir to a valid static build output directory and retry preflight.'
                    : failedCheck.code === 'provider_auth_failed'
                      ? 'Verify Cloudflare account credentials in worker env and retry preflight.'
                      : failedCheck.code === 'provider_scope_missing'
                        ? 'Grant required Cloudflare token scopes and retry preflight.'
                        : failedCheck.code === 'provider_project_not_found'
                          ? 'Set WORKSPACE_DEPLOY_PROJECT_NAME to a valid Workers project and retry preflight.'
                          : failedCheck.code === 'provider_rate_limited'
                            ? 'Wait for provider rate limits to reset and retry preflight.'
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
