import type { AuthContext, Env, WorkspaceResponse } from '../../types.js';
import { parseCheckpointCreateRequest } from '../checkpoint-jobs.js';
import type { ParsedCheckpointCreateRequest } from '../checkpoint-jobs.js';
import {
  appendWorkspaceEvent,
  createWorkspace,
  generateWorkspaceId,
  getWorkspace,
  markWorkspaceDeleted,
  markWorkspaceFailed,
  markWorkspaceReady,
} from '../../lib/db.js';
import {
  ensureWorkspaceGitBaseline,
  getWorkspaceSandbox,
  hydrateWorkspaceFilesystem,
  isSandboxAlreadyGoneError,
} from './sandbox.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

async function sha256Hex(input: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

function sourceBundleR2Key(workspaceId: string, commitSha: string): string {
  return `workspaces/${workspaceId}/source/${commitSha}.tar.gz`;
}

function buildWorkspaceCreateFallback(input: {
  workspaceId: string;
  sourceType: 'checkpoint';
  checkpointId: string | null;
  commitSha: string;
  sourceRef?: string;
  sourceProjectRoot?: string;
  sourceBundleKey: string;
  sourceBundleSha256: string;
  sourceBundleBytes: number;
  sandboxId: string;
  baselineReady: boolean;
}): WorkspaceResponse {
  const now = new Date().toISOString();
  return {
    id: input.workspaceId,
    status: 'ready',
    sourceType: input.sourceType,
    checkpointId: input.checkpointId,
    commitSha: input.commitSha,
    sourceRef: input.sourceRef ?? null,
    sourceProjectRoot: input.sourceProjectRoot ?? null,
    sourceBundleKey: input.sourceBundleKey,
    sourceBundleSha256: input.sourceBundleSha256,
    sourceBundleBytes: input.sourceBundleBytes,
    sandboxId: input.sandboxId,
    baselineReady: input.baselineReady,
    errorCode: null,
    errorMessage: null,
    lastDeploymentId: null,
    lastDeploymentStatus: null,
    lastDeployedUrl: null,
    lastDeployedAt: null,
    lastDeploymentErrorCode: null,
    lastDeploymentErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    eventsUrl: `/api/workspaces/${input.workspaceId}/events`,
  };
}

export async function handleCreateWorkspace(request: Request, env: Env, authContext?: AuthContext): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let parsed: ParsedCheckpointCreateRequest;
  try {
    parsed = await parseCheckpointCreateRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 400);
  }

  const workspaceId = generateWorkspaceId();
  const sandboxId = `workspace-${workspaceId}`;
  const sourceBundleKey = sourceBundleR2Key(workspaceId, parsed.metadata.source.commitSha);
  let bundleUploaded = false;
  let workspaceCreated = false;
  let workspaceReadyPersisted = false;
  let baselineReady = true;

  try {
    await env.SOURCE_BUNDLES.put(sourceBundleKey, parsed.bundleArrayBuffer, {
      httpMetadata: {
        contentType: parsed.bundle.type || 'application/gzip',
      },
      customMetadata: {
        source_type: parsed.metadata.source.type,
        checkpoint_id: parsed.metadata.source.checkpointId ?? '',
        commit_sha: parsed.metadata.source.commitSha,
        source_ref: parsed.metadata.source.ref ?? '',
        source_project_root: parsed.metadata.source.projectRoot ?? '',
      },
    });
    bundleUploaded = true;

    await createWorkspace(env.DB, {
      id: workspaceId,
      sourceType: parsed.metadata.source.type,
      checkpointId: parsed.metadata.source.checkpointId,
      commitSha: parsed.metadata.source.commitSha,
      sourceRef: parsed.metadata.source.ref,
      sourceProjectRoot: parsed.metadata.source.projectRoot,
      sourceBundleKey,
      sourceBundleSha256: parsed.bundleSha256,
      sourceBundleBytes: parsed.bundleBytes,
      sandboxId,
      accountId: authContext?.isHostedMode ? authContext.accountId : null,
    });
    workspaceCreated = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_created',
      payload: {
        checkpointId: parsed.metadata.source.checkpointId,
        commitSha: parsed.metadata.source.commitSha,
        sourceRef: parsed.metadata.source.ref ?? null,
      },
    });

    await hydrateWorkspaceFilesystem(env, sandboxId, parsed.bundleArrayBuffer);
    const workspaceSandbox = await getWorkspaceSandbox(env, sandboxId);
    try {
      await ensureWorkspaceGitBaseline(workspaceSandbox);
    } catch (error) {
      baselineReady = false;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_git_baseline_failed',
          payload: { message },
        });
      } catch {
        // Best-effort event only.
      }
    }
    const markedReady = await markWorkspaceReady(env.DB, workspaceId, baselineReady);
    if (!markedReady) {
      return jsonResponse({ error: 'Workspace can no longer transition to ready (likely deleted)' }, 409);
    }
    workspaceReadyPersisted = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_ready',
      payload: {
        baselineReady,
      },
    });

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace created but could not be loaded' }, 500);
    }

    return jsonResponse({ workspace }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (workspaceReadyPersisted) {
      try {
        const workspace = await getWorkspace(env.DB, workspaceId);
        if (workspace) {
          return jsonResponse({ workspace }, 201);
        }
      } catch {
        // Best-effort readback only.
      }

      const workspace = buildWorkspaceCreateFallback({
        workspaceId,
        sourceType: parsed.metadata.source.type,
        checkpointId: parsed.metadata.source.checkpointId,
        commitSha: parsed.metadata.source.commitSha,
        sourceRef: parsed.metadata.source.ref,
        sourceProjectRoot: parsed.metadata.source.projectRoot,
        sourceBundleKey,
        sourceBundleSha256: parsed.bundleSha256,
        sourceBundleBytes: parsed.bundleBytes,
        sandboxId,
        baselineReady,
      });

      return jsonResponse(
        {
          workspace,
          warning: `Workspace became ready but post-ready bookkeeping failed: ${message}`,
        },
        201
      );
    }

    if (workspaceCreated) {
      try {
        await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_create_failed');
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_failed',
          payload: { message },
        });
      } catch {
        // Best-effort only.
      }
    }

    if (bundleUploaded && !workspaceCreated) {
      try {
        await env.SOURCE_BUNDLES.delete(sourceBundleKey);
      } catch {
        // Best-effort cleanup.
      }
    }

    return jsonResponse({ error: `Failed to create workspace: ${message}` }, 500);
  }
}

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

    const bundle = await env.SOURCE_BUNDLES.get(workspace.sourceBundleKey);
    if (!bundle) {
      return jsonResponse({ error: 'Workspace source bundle not found' }, 404);
    }

    const sourceBytes = await bundle.arrayBuffer();
    const sourceHash = await sha256Hex(sourceBytes);
    if (sourceHash !== workspace.sourceBundleSha256) {
      return jsonResponse({ error: 'Workspace source bundle checksum mismatch' }, 500);
    }

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_reset_started',
      payload: {},
    });

    await hydrateWorkspaceFilesystem(env, workspace.sandboxId, sourceBytes);
    const workspaceSandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    try {
      await ensureWorkspaceGitBaseline(workspaceSandbox);
    } catch (error) {
      baselineReady = false;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_git_baseline_failed',
          payload: { message },
        });
      } catch {
        // Best-effort event only.
      }
    }
    const markedReady = await markWorkspaceReady(env.DB, workspaceId, baselineReady);
    if (!markedReady) {
      return jsonResponse({ error: 'Workspace can no longer transition to ready (likely deleted)' }, 409);
    }
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
      if (isSandboxAlreadyGoneError(error)) {
        // Treat missing/already-destroyed sandbox as idempotent success.
      } else {
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
