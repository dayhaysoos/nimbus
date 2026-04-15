import type { AuthContext, Env, WorkspaceResponse } from '../../types.js';
import { parseCheckpointCreateRequest } from '../checkpoint-jobs.js';
import type { ParsedCheckpointCreateRequest } from '../checkpoint-jobs.js';
import {
  appendWorkspaceEvent,
  createWorkspace,
  generateWorkspaceId,
  getWorkspace,
  markWorkspaceFailed,
  WorkspaceCreateIdempotencyConflictError,
  WorkspaceCreateInProgressError,
} from '../../lib/db.js';
import { hydrateWorkspaceToReady, WorkspaceReadyTransitionError } from './ready.js';
import { jsonResponse } from './shared.js';
import {
  buildWorkspaceCreateFallback,
  sourceBundleR2Key,
  uploadWorkspaceSourceBundle,
} from './source-bundle.js';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function buildWorkspaceCreateIdempotencyPayload(input: {
  checkpointId: string | null;
  commitSha: string;
  projectRoot: string | null | undefined;
  sourceBundleSha256: string;
}): Record<string, unknown> {
  return {
    sourceType: 'checkpoint',
    checkpointId: input.checkpointId,
    commitSha: input.commitSha,
    projectRoot: input.projectRoot ?? '.',
    sourceBundleSha256: input.sourceBundleSha256,
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
  const idempotencyKey = (request.headers.get('Idempotency-Key') ?? '').trim();
  const accountScope = authContext?.isHostedMode ? `account:${authContext.accountId}` : 'self-hosted';
  const requestPayloadSha256 = idempotencyKey
    ? await sha256Hex(
        JSON.stringify(
          buildWorkspaceCreateIdempotencyPayload({
            checkpointId: parsed.metadata.source.checkpointId,
            commitSha: parsed.metadata.source.commitSha,
            projectRoot: parsed.metadata.source.projectRoot,
            sourceBundleSha256: parsed.bundleSha256,
          })
        )
      )
    : null;
  let bundleUploaded = false;
  let workspaceCreated = false;
  let workspaceReadyPersisted = false;
  let baselineReady = true;

  try {
    const createdWorkspace = await createWorkspace(env.DB, {
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
      idempotency: idempotencyKey && requestPayloadSha256
        ? {
            key: idempotencyKey,
            accountScope,
            requestPayloadSha256,
          }
        : undefined,
    });
    if (createdWorkspace.reused) {
      return jsonResponse({ workspace: createdWorkspace.workspace, reused: true }, 200);
    }
    workspaceCreated = true;

    await uploadWorkspaceSourceBundle(env, sourceBundleKey, parsed);
    bundleUploaded = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_created',
      payload: {
        checkpointId: parsed.metadata.source.checkpointId,
        commitSha: parsed.metadata.source.commitSha,
        sourceRef: parsed.metadata.source.ref ?? null,
      },
    });

    ({ baselineReady } = await hydrateWorkspaceToReady(env, workspaceId, sandboxId, parsed.bundleArrayBuffer));
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

    return jsonResponse({ workspace, reused: false }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof WorkspaceCreateIdempotencyConflictError) {
      return jsonResponse({ error: error.message }, 409);
    }

    if (error instanceof WorkspaceCreateInProgressError) {
      return jsonResponse(
        {
          error: error.message,
          code: 'workspace_create_in_progress',
          workspaceId: error.workspaceId,
          retryable: true,
        },
        409
      );
    }

    if (error instanceof WorkspaceReadyTransitionError) {
      return jsonResponse({ error: error.message }, 409);
    }

    if (workspaceReadyPersisted) {
      try {
        const workspace = await getWorkspace(env.DB, workspaceId);
        if (workspace) {
          return jsonResponse({ workspace }, 201);
        }
      } catch {
        // Best-effort readback only.
      }

      const workspace: WorkspaceResponse = buildWorkspaceCreateFallback({
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
          reused: false,
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
