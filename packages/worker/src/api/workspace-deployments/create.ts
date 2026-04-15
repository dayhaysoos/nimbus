import type { AuthContext, Env } from '../../types.js';
import {
  appendWorkspaceDeploymentEvent,
  createWorkspaceDeployment,
  generateWorkspaceDeploymentId,
  getWorkspaceDeployment,
  hasWorkspaceDeploymentEvent,
  updateWorkspaceDeploymentSummary,
  WorkspaceDeploymentIdempotencyConflictError,
} from '../../lib/db.js';
import { createWorkspaceDeploymentQueueMessage } from '../../lib/workspace-deployment-queue.js';
import { runWorkspaceDeploymentInlineWithRetries, runWorkspaceDeploymentPreflight } from '../../lib/workspace-deployment-runner.js';
import {
  createWorkspaceDeployProvider,
  getWorkspaceDeployProviderConfigError,
  getWorkspaceDeployProviderName,
  normalizeProviderError,
} from '../../lib/workspace-deploy-provider.js';
import {
  MAX_PROVENANCE_INTENT_CONTEXT_LENGTH,
  MAX_PROVENANCE_REPO_LENGTH,
  MAX_PROVENANCE_SESSION_ID_LENGTH,
  PROVIDER_PRECHECK_LEASE_MS,
  buildDeploymentIdempotencyPayload,
  deploymentCreateResponseStatus,
  ensureWorkspaceDeployEnabled,
  ensureWorkspaceReady,
  isSafeRelativeOutputDir,
  jsonResponse,
  parseBoolean,
  parseDeployOutputDir,
  parseEnvBoolean,
  parseInteger,
  sha256Hex,
} from './shared.js';

export async function handleCreateWorkspaceDeployment(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const forceInlineDeploys = parseEnvBoolean(env.WORKSPACE_DEPLOY_FORCE_INLINE, false);
    const deployQueue = env.WORKSPACE_DEPLOYS_QUEUE;
    const useDeployQueue = Boolean(deployQueue) && !forceInlineDeploys;

    const enabled = await ensureWorkspaceDeployEnabled(env);
    if (enabled) {
      return enabled;
    }

    const effectiveAuthContext =
      authContext ??
      ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
    const workspaceCheck = await ensureWorkspaceReady(env, workspaceId, effectiveAuthContext);
    if (workspaceCheck) {
      return workspaceCheck;
    }

    if (!useDeployQueue && !ctx) {
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
        repo:
          typeof provenance.repo === 'string' && provenance.repo.trim()
            ? provenance.repo.trim().slice(0, MAX_PROVENANCE_REPO_LENGTH)
            : null,
        sessionIds: Array.isArray(provenance.sessionIds)
          ? provenance.sessionIds
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim().slice(0, MAX_PROVENANCE_SESSION_ID_LENGTH))
            .filter(Boolean)
            .slice(0, 8)
          : [],
        transcriptUrl:
          typeof provenance.transcriptUrl === 'string' && provenance.transcriptUrl.trim()
            ? provenance.transcriptUrl.trim().slice(0, 1_024)
            : null,
        intentSessionContext: Array.isArray(provenance.intentSessionContext)
          ? provenance.intentSessionContext
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim().slice(0, MAX_PROVENANCE_INTENT_CONTEXT_LENGTH))
            .filter(Boolean)
            .slice(0, 8)
          : [],
      },
    };

    const deploymentProvenance = {
      ...requestPayload.provenance,
      deployProvider: provider,
      deployOutputDir: outputDir,
    };

    const requestPayloadSha256 = await sha256Hex(JSON.stringify(buildDeploymentIdempotencyPayload(requestPayload)));
    const legacyRequestPayloadSha256 = await sha256Hex(
      JSON.stringify(buildDeploymentIdempotencyPayload(requestPayload, { includeRepo: false }))
    );

    const created = await createWorkspaceDeployment(env.DB, {
      id: generateWorkspaceDeploymentId(),
      workspaceId,
      provider,
      idempotencyKey,
      requestPayload,
      requestPayloadSha256,
      requestPayloadSha256Aliases: legacyRequestPayloadSha256 === requestPayloadSha256 ? [] : [legacyRequestPayloadSha256],
      maxRetries,
      provenance: deploymentProvenance,
    });

    if (!created.reused) {
      await appendWorkspaceDeploymentEvent(env.DB, {
        workspaceId,
        deploymentId: created.deployment.id,
        eventType: 'deployment_created',
        payload: {
          provider,
          maxRetries,
          provenance: deploymentProvenance,
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
            return jsonResponse({ deployment: concurrent, reused: true }, deploymentCreateResponseStatus(true));
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
            return jsonResponse({ deployment: concurrent, reused: true }, deploymentCreateResponseStatus(true));
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
            return jsonResponse({ deployment: concurrent, reused: true }, deploymentCreateResponseStatus(true));
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
            return jsonResponse({ deployment: concurrent, reused: true }, deploymentCreateResponseStatus(true));
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
        if (useDeployQueue) {
          await deployQueue!.send(
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
            mode: useDeployQueue ? 'queue' : 'inline',
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
    return jsonResponse({ deployment: deploymentForQueue, reused: created.reused }, responseStatus);
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
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const enabled = await ensureWorkspaceDeployEnabled(env);
  if (enabled) {
    return enabled;
  }

  const workspaceCheck = await ensureWorkspaceReady(env, workspaceId, effectiveAuthContext);
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
