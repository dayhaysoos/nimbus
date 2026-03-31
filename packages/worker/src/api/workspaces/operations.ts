import type { AuthContext, Env } from '../../types.js';
import type { WorkspaceOperationType, WorkspaceResponse } from '../../types.js';
import {
  createWorkspaceOperation,
  generateWorkspaceOperationId,
  getWorkspaceOperation,
  WorkspaceIdempotencyConflictError,
} from '../../lib/db.js';
import { executeWorkspaceArtifactOperation } from './operations-export.js';
import { executeForkGithubWorkspaceOperation } from './operations-fork.js';
import {
  jsonResponse,
  requireWorkspaceAccess,
  resolveWorkspaceOr404,
  workspaceNotReadyResponse,
} from './shared.js';

function getIdempotencyKey(request: Request): string {
  return (request.headers.get('Idempotency-Key') ?? '').trim();
}

async function sha256HexFromText(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function parseOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength === '0') {
    return {};
  }

  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Request body must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

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

async function processWorkspaceOperationIfQueued(
  env: Env,
  workspace: WorkspaceResponse,
  operationId: string,
  type: WorkspaceOperationType,
  requestPayload: Record<string, unknown>
): Promise<void> {
  if (type === 'fork_github') {
    await executeForkGithubWorkspaceOperation(env, workspace, operationId, requestPayload);
    return;
  }

  if (type === 'export_patch' || type === 'export_zip') {
    await executeWorkspaceArtifactOperation(env, workspace, operationId, type);
    return;
  }

  throw new Error(`Unsupported workspace operation type: ${type}`);
}

async function handleCreateWorkspaceOperation(
  workspaceId: string,
  request: Request,
  env: Env,
  type: WorkspaceOperationType,
  authContext?: AuthContext,
  ctx?: ExecutionContext
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
    if (workspace.status !== 'ready') {
      return workspaceNotReadyResponse(workspace);
    }

    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }

    const payload = await parseOptionalJsonBody(request);
    const payloadHash = await sha256HexFromText(JSON.stringify(payload));
    const operationId = generateWorkspaceOperationId();

    const created = await createWorkspaceOperation(env.DB, {
      id: operationId,
      workspaceId,
      type,
      idempotencyKey,
      requestPayload: payload,
      requestPayloadSha256: payloadHash,
    });

    if (created.operation.status === 'queued') {
      const execution = processWorkspaceOperationIfQueued(env, workspace, created.operation.id, type, payload);
      if (ctx) {
        ctx.waitUntil(execution);
      } else {
        await execution;
      }
    }

    const latestOperation = await getWorkspaceOperation(env.DB, workspaceId, created.operation.id);
    const operationResponse = latestOperation ?? created.operation;

    return jsonResponse({ operation: operationResponse }, 202);
  } catch (error) {
    if (error instanceof WorkspaceIdempotencyConflictError) {
      return jsonResponse(
        {
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency key was already used with a different payload.',
          },
        },
        409
      );
    }
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleCreateWorkspaceZipExport(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'export_zip', authContext, ctx);
}

export async function handleCreateWorkspacePatchExport(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'export_patch', authContext, ctx);
}

export async function handleCreateWorkspaceGithubFork(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'fork_github', authContext, ctx);
}
