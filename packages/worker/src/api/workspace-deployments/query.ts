import type { AuthContext, Env } from '../../types.js';
import { getWorkspaceDeployment, listWorkspaceDeploymentEvents } from '../../lib/db.js';
import { createWorkspaceDeploymentQueueMessage } from '../../lib/workspace-deployment-queue.js';
import { cancelWorkspaceDeployment, runWorkspaceDeploymentInlineWithRetries } from '../../lib/workspace-deployment-runner.js';
import {
  ensureWorkspaceExists,
  jsonResponse,
  nextActionForDeploymentError,
  parseEnvBoolean,
} from './shared.js';

const DEPLOYMENT_STALE_RETRY_SCHEDULED_GRACE_MS = 60_000;
const PRE_PROVIDER_DEPLOYMENT_STALE_RUNNING_GRACE_MS = 12 * 60 * 1000;
const POST_PROVIDER_DEPLOYMENT_STALE_RUNNING_GRACE_MS = 30 * 60 * 1000;

function parseDeploymentTimestampMs(timestamp: string | null | undefined): number | null {
  if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRecoveryRunningThresholdMs(deployment: {
  providerDeploymentId: string | null;
}): number {
  return deployment.providerDeploymentId
    ? POST_PROVIDER_DEPLOYMENT_STALE_RUNNING_GRACE_MS
    : PRE_PROVIDER_DEPLOYMENT_STALE_RUNNING_GRACE_MS;
}

async function replayQueuedWorkspaceDeployment(
  env: Env,
  workspaceId: string,
  deploymentId: string,
  maxRetries: number,
  ctx?: ExecutionContext
): Promise<void> {
  const forceInlineDeploys = parseEnvBoolean(env.WORKSPACE_DEPLOY_FORCE_INLINE, false);
  const useDeployQueue = Boolean(env.WORKSPACE_DEPLOYS_QUEUE) && !forceInlineDeploys;
  if (useDeployQueue) {
    await env.WORKSPACE_DEPLOYS_QUEUE!.send(createWorkspaceDeploymentQueueMessage(workspaceId, deploymentId));
    return;
  }

  const inlineRecovery = runWorkspaceDeploymentInlineWithRetries(env, workspaceId, deploymentId, maxRetries + 1);
  if (ctx) {
    ctx.waitUntil(inlineRecovery);
    return;
  }

  await inlineRecovery;
}

async function recoverWorkspaceDeploymentOnReadIfNeeded(
  env: Env,
  workspaceId: string,
  deployment: Awaited<ReturnType<typeof getWorkspaceDeployment>>,
  ctx?: ExecutionContext
): Promise<void> {
  if (!deployment) {
    return;
  }

  if (deployment.status === 'running') {
    const startedMs =
      parseDeploymentTimestampMs(deployment.startedAt) ??
      parseDeploymentTimestampMs(deployment.updatedAt) ??
      parseDeploymentTimestampMs(deployment.createdAt);
    if (startedMs === null) {
      return;
    }

    const staleForMs = Date.now() - startedMs;
    if (staleForMs < readRecoveryRunningThresholdMs(deployment)) {
      return;
    }

    if (!deployment.cancelRequestedAt && deployment.attemptCount <= deployment.maxRetries) {
      const now = new Date().toISOString();
      const retryMessage = `Deployment execution stalled in running state for ${Math.floor(staleForMs / 1000)}s.`;
      const retryUpdate = await env.DB
        .prepare(
          `UPDATE workspace_deployments
           SET status = 'queued',
               started_at = NULL,
               finished_at = NULL,
               error_code = 'retry_scheduled',
               error_message = ?,
               updated_at = ?
           WHERE id = ?
             AND workspace_id = ?
             AND status = 'running'
             AND cancel_requested_at IS NULL`
        )
        .bind(retryMessage, now, deployment.id, workspaceId)
        .run();

      if ((retryUpdate.meta?.changes ?? 0) > 0) {
        await env.DB
          .prepare(
            `UPDATE workspaces
             SET last_deployment_status = ?,
                 last_deployment_error_code = ?,
                 last_deployment_error_message = ?,
                 updated_at = ?
             WHERE id = ?
               AND last_deployment_id = ?`
          )
          .bind('queued', 'retry_scheduled', retryMessage, now, workspaceId, deployment.id)
          .run();
        const nextSeq = await env.DB
          .prepare(
            `UPDATE workspace_deployments
             SET last_event_seq = last_event_seq + 1
             WHERE id = ? AND workspace_id = ?
             RETURNING last_event_seq`
          )
          .bind(deployment.id, workspaceId)
          .first<{ last_event_seq: number }>();
        if (nextSeq) {
          await env.DB
            .prepare(
              `INSERT INTO workspace_deployment_events (workspace_id, deployment_id, seq, event_type, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              workspaceId,
              deployment.id,
              nextSeq.last_event_seq,
              'deployment_retry_scheduled',
              JSON.stringify({
                attemptCount: deployment.attemptCount,
                maxRetries: deployment.maxRetries,
                reason: 'stale_running_timeout',
                staleForSeconds: Math.floor(staleForMs / 1000),
                recoveredOnRead: true,
              }),
              now
            )
            .run();
        }
        await replayQueuedWorkspaceDeployment(env, workspaceId, deployment.id, deployment.maxRetries, ctx);
        return;
      }
    }

    const inlineRecovery = runWorkspaceDeploymentInlineWithRetries(env, workspaceId, deployment.id, 2);
    if (ctx) {
      ctx.waitUntil(inlineRecovery);
      return;
    }
    await inlineRecovery;
    return;
  }

  if (deployment.status !== 'queued' || deployment.error?.code !== 'retry_scheduled') {
    return;
  }

  const updatedMs =
    parseDeploymentTimestampMs(deployment.updatedAt) ?? parseDeploymentTimestampMs(deployment.createdAt);
  if (updatedMs === null) {
    return;
  }

  const queuedForMs = Date.now() - updatedMs;
  if (queuedForMs < DEPLOYMENT_STALE_RETRY_SCHEDULED_GRACE_MS) {
    return;
  }

  const now = new Date().toISOString();
  const touchUpdate = await env.DB
    .prepare(
      `UPDATE workspace_deployments
       SET updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND status = 'queued'
         AND error_code = 'retry_scheduled'`
    )
    .bind(now, deployment.id, workspaceId)
    .run();
  if ((touchUpdate.meta?.changes ?? 0) === 0) {
    return;
  }

  const nextSeq = await env.DB
    .prepare(
      `UPDATE workspace_deployments
       SET last_event_seq = last_event_seq + 1
       WHERE id = ? AND workspace_id = ?
       RETURNING last_event_seq`
    )
    .bind(deployment.id, workspaceId)
    .first<{ last_event_seq: number }>();
  if (nextSeq) {
    await env.DB
      .prepare(
        `INSERT INTO workspace_deployment_events (workspace_id, deployment_id, seq, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        workspaceId,
        deployment.id,
        nextSeq.last_event_seq,
        'deployment_reenqueue_recovered',
        JSON.stringify({
          reason: 'retry_scheduled_poll_recovery',
          queuedForSeconds: Math.floor(queuedForMs / 1000),
        }),
        now
      )
      .run();
  }
  await replayQueuedWorkspaceDeployment(env, workspaceId, deployment.id, deployment.maxRetries, ctx);
}

export async function handleGetWorkspaceDeployment(
  workspaceId: string,
  deploymentId: string,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId, effectiveAuthContext);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  let deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }
  await recoverWorkspaceDeploymentOnReadIfNeeded(env, workspaceId, deployment, ctx);
  deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
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
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId, effectiveAuthContext);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  let deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
  if (!deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }
  await recoverWorkspaceDeploymentOnReadIfNeeded(env, workspaceId, deployment, ctx);
  deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
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
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const forceInlineDeploys = parseEnvBoolean(env.WORKSPACE_DEPLOY_FORCE_INLINE, false);
  const useDeployQueue = Boolean(env.WORKSPACE_DEPLOYS_QUEUE) && !forceInlineDeploys;

  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId, effectiveAuthContext);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const cancelResult = await cancelWorkspaceDeployment(env, workspaceId, deploymentId);
  if (!cancelResult.deployment) {
    return jsonResponse({ error: 'Deployment not found' }, 404);
  }

  if (cancelResult.updated) {
    if (
      !useDeployQueue &&
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
