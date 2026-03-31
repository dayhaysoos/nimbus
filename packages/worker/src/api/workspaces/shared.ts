import type { AuthContext, Env, WorkspaceResponse } from '../../types.js';
import { getWorkspace, getWorkspaceAccountId } from '../../lib/db.js';
import { canAccessAccount } from '../../lib/authz.js';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Nimbus-Api-Key',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function requireWorkspaceAccess(
  env: Env,
  workspaceId: string,
  authContext?: AuthContext
): Promise<Response | null> {
  if (!authContext) {
    return null;
  }
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

export async function resolveWorkspaceOr404(env: Env, workspaceId: string): Promise<WorkspaceResponse | null> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return null;
  }
  if (workspace.status === 'deleted') {
    return null;
  }
  return workspace;
}

export function workspaceNotReadyResponse(workspace: WorkspaceResponse): Response {
  return jsonResponse(
    {
      error: `Workspace is not ready (status: ${workspace.status})`,
      status: workspace.status,
    },
    409
  );
}
