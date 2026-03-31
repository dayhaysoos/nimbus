import type { AuthContext, Env } from '../../types.js';
import { getWorkspaceDeployment, listWorkspaceDeploymentEvents } from '../../lib/db.js';
import { cancelWorkspaceDeployment, runWorkspaceDeploymentInlineWithRetries } from '../../lib/workspace-deployment-runner.js';
import {
  ensureWorkspaceExists,
  jsonResponse,
  nextActionForDeploymentError,
  parseEnvBoolean,
} from './shared.js';

export async function handleGetWorkspaceDeployment(
  workspaceId: string,
  deploymentId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId, effectiveAuthContext);
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
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId, effectiveAuthContext);
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
