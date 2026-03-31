import type { AuthContext, Env } from '../../types.js';
import {
  appendWorkspaceEvent,
  getWorkspace,
  markWorkspaceDeleted,
  markWorkspaceFailed,
} from '../../lib/db.js';
import { getWorkspaceSandbox, isSandboxAlreadyGoneError } from './sandbox.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

export async function handleDeleteWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    if (workspace.status === 'deleted') {
      return jsonResponse({ workspaceId, status: 'deleted' });
    }

    try {
      const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
      await sandbox.destroy();
    } catch (error) {
      if (!isSandboxAlreadyGoneError(error)) {
        const message = error instanceof Error ? error.message : String(error);

        try {
          await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_delete_failed');
          await appendWorkspaceEvent(env.DB, {
            workspaceId,
            eventType: 'workspace_delete_failed',
            payload: { message },
          });
        } catch {
          // Best-effort failure state update.
        }

        return jsonResponse({ error: `Failed to destroy workspace sandbox: ${message}` }, 500);
      }
    }

    if (env.SOURCE_BUNDLES) {
      try {
        await env.SOURCE_BUNDLES.delete(workspace.sourceBundleKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_delete_partial');
          await appendWorkspaceEvent(env.DB, {
            workspaceId,
            eventType: 'workspace_delete_partial',
            payload: { message },
          });
        } catch {
          // Best-effort status/event update for partial delete.
        }
        return jsonResponse({ error: `Failed to delete workspace source bundle: ${message}` }, 503);
      }
    }

    const markedDeleted = await markWorkspaceDeleted(env.DB, workspaceId);
    if (!markedDeleted) {
      return jsonResponse({ error: 'Workspace can no longer transition to deleted' }, 409);
    }
    try {
      await appendWorkspaceEvent(env.DB, {
        workspaceId,
        eventType: 'workspace_deleted',
        payload: {},
      });
    } catch {
      // Deletion already persisted; event append is best-effort.
    }

    return jsonResponse({ workspaceId, status: 'deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to delete workspace: ${message}` }, 500);
  }
}
