import type { AuthContext, Env } from '../../types.js';
import { getWorkspace } from '../../lib/db.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

export async function handleGetWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    return jsonResponse(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}
