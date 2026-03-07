import type { Sandbox } from '@cloudflare/sandbox';
import type { Env, WorkspaceResponse } from '../types.js';
import { parseCheckpointCreateRequest } from './checkpoint-jobs.js';
import type { ParsedCheckpointCreateRequest } from './checkpoint-jobs.js';
import {
  appendWorkspaceEvent,
  createWorkspace,
  generateWorkspaceId,
  getWorkspace,
  listWorkspaceEvents,
  markWorkspaceDeleted,
  markWorkspaceFailed,
  markWorkspaceReady,
} from '../lib/db.js';

const WORKSPACE_ROOT = '/workspace';
const BUNDLE_BASE64_PATH = '/tmp/workspace-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/workspace-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/workspace-source.tar.gz.base64.part';
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, contents: string): Promise<unknown>;
  destroy(): Promise<void>;
}

async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<void> {
  const result = await sandbox.exec(command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed (${command}) with exit ${result.exitCode}: ${output || 'No output'}`);
  }
}

function isSandboxAlreadyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(sandbox.*not found|sandbox.*does not exist|no such sandbox|already destroyed)/i.test(message);
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function sourceBundleR2Key(workspaceId: string, commitSha: string): string {
  return `workspaces/${workspaceId}/source/${commitSha}.tar.gz`;
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

async function writeBundleBase64InChunks(sandbox: SandboxClient, bundleBytes: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(bundleBytes);

  await runSandboxCommand(sandbox, `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`);

  let partIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BUNDLE_BASE64_CHUNK_BYTES, bytes.byteLength));
    const chunkBase64 = toBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    const partPath = `${BUNDLE_BASE64_PART_PREFIX}.${String(partIndex).padStart(4, '0')}`;
    await sandbox.writeFile(partPath, chunkBase64);
    partIndex += 1;
  }

  await runSandboxCommand(sandbox, `cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`);
}

async function hydrateWorkspaceFilesystem(env: Env, sandboxId: string, sourceBytes: ArrayBuffer): Promise<void> {
  const sandbox = await getWorkspaceSandbox(env, sandboxId);

  await runSandboxCommand(sandbox, `rm -rf ${shellQuote(WORKSPACE_ROOT)} && mkdir -p ${shellQuote(WORKSPACE_ROOT)}`);
  await writeBundleBase64InChunks(sandbox, sourceBytes);
  await runSandboxCommand(
    sandbox,
    `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(WORKSPACE_ROOT)}`,
    { timeout: 8 * 60 * 1000 }
  );
  await runSandboxCommand(
    sandbox,
    `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
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
    baselineReady: true,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    eventsUrl: `/api/workspaces/${input.workspaceId}/events`,
  };
}

export async function handleCreateWorkspace(request: Request, env: Env): Promise<Response> {
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
    const markedReady = await markWorkspaceReady(env.DB, workspaceId);
    if (!markedReady) {
      return jsonResponse({ error: 'Workspace can no longer transition to ready (likely deleted)' }, 409);
    }
    workspaceReadyPersisted = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_ready',
      payload: {
        baselineReady: true,
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

export async function handleGetWorkspace(workspaceId: string, env: Env): Promise<Response> {
  try {
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
  env: Env
): Promise<Response> {
  try {
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

export async function handleResetWorkspace(workspaceId: string, env: Env): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let workspaceReadyPersisted = false;
  let originalWorkspace: WorkspaceResponse | null = null;

  try {
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
    const markedReady = await markWorkspaceReady(env.DB, workspaceId);
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
          baselineReady: true,
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

export async function handleDeleteWorkspace(workspaceId: string, env: Env): Promise<Response> {
  try {
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
