import type { AuthContext, Env, WorkspaceResponse } from '../../types.js';
import {
  appendWorkspaceEvent,
  getWorkspace,
  markWorkspaceFailed,
} from '../../lib/db.js';
import { hydrateWorkspaceToReady, WorkspaceReadyTransitionError } from './ready.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';
import { loadVerifiedWorkspaceSourceBundle } from './source-bundle.js';

export async function handleResetWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let workspaceReadyPersisted = false;
  let originalWorkspace: WorkspaceResponse | null = null;
  let baselineReady = true;

  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    originalWorkspace = workspace;

    if (workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace has been deleted' }, 409);
    }

    const sourceBytesOrResponse = await loadVerifiedWorkspaceSourceBundle(env, workspace);
    if (sourceBytesOrResponse instanceof Response) {
      const payload = (await sourceBytesOrResponse.json()) as { error: string };
      return jsonResponse({ error: payload.error }, sourceBytesOrResponse.status);
    }
    const sourceBytes = sourceBytesOrResponse;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_reset_started',
      payload: {},
    });

    ({ baselineReady } = await hydrateWorkspaceToReady(env, workspaceId, workspace.sandboxId, sourceBytes));
    workspaceReadyPersisted = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_reset_completed',
      payload: {},
    });

    const refreshed = await getWorkspace(env.DB, workspaceId);
    return jsonResponse({ workspace: refreshed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof WorkspaceReadyTransitionError) {
      return jsonResponse({ error: error.message }, 409);
    }

    if (workspaceReadyPersisted) {
      try {
        const workspace = await getWorkspace(env.DB, workspaceId);
        if (workspace) {
          return jsonResponse({ workspace });
        }
      } catch {
        // Best-effort readback only.
      }

      if (originalWorkspace) {
        const fallbackWorkspace: WorkspaceResponse = {
          ...originalWorkspace,
          status: 'ready',
          baselineReady,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date().toISOString(),
        };
        return jsonResponse({ workspace: fallbackWorkspace, warning: `Post-ready reset bookkeeping failed: ${message}` });
      }

      return jsonResponse({ error: `Reset reached ready state but result could not be loaded: ${message}` }, 500);
    }

    try {
      const markedFailed = await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_reset_failed');
      if (!markedFailed) {
        return jsonResponse({ error: 'Workspace reset failed after workspace was deleted' }, 409);
      }
      await appendWorkspaceEvent(env.DB, {
        workspaceId,
        eventType: 'workspace_reset_failed',
        payload: { message },
      });
    } catch {
      // Best-effort failure state update.
    }

    return jsonResponse({ error: `Failed to reset workspace: ${message}` }, 500);
  }
}
