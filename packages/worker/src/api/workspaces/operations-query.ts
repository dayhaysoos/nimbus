import type { AuthContext, Env } from '../../types.js';
import { getWorkspaceOperation } from '../../lib/db.js';
import { jsonResponse, requireWorkspaceAccess, resolveWorkspaceOr404 } from './shared.js';

export async function handleGetWorkspaceOperation(
  workspaceId: string,
  operationId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
    if (!operation) {
      return jsonResponse({ error: 'Operation not found' }, 404);
    }

    return jsonResponse({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}
