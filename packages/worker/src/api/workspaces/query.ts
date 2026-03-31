import type { AuthContext, Env } from '../../types.js';
import { getWorkspace, listWorkspaceEvents } from '../../lib/db.js';
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

export async function handleGetWorkspaceEvents(
  workspaceId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const url = new URL(request.url);
    const fromRaw = Number(url.searchParams.get('from') ?? '0');
    const limitRaw = Number(url.searchParams.get('limit') ?? '500');
    const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 500;
    const events = await listWorkspaceEvents(env.DB, workspaceId, from, limit);

    return jsonResponse({ workspaceId, events });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}
