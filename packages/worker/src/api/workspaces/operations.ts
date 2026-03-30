import type { AuthContext, Env } from '../../types.js';
import type { WorkspaceOperationType, WorkspaceResponse } from '../../types.js';
import {
  claimWorkspaceOperationForExecution,
  createWorkspaceArtifact,
  createWorkspaceOperation,
  generateWorkspaceArtifactId,
  generateWorkspaceOperationId,
  getWorkspaceOperation,
  updateWorkspaceOperationStatus,
  WorkspaceIdempotencyConflictError,
} from '../../lib/db.js';
import {
  detectPotentialSecrets,
  exportWorkspaceZipBase64,
  fromBase64,
  getWorkspaceSandbox,
  listOversizedWorkspaceFiles,
  runWorkspaceDiffAgainstHead,
  workspaceHasChanges,
  workspaceHasGitHead,
} from './sandbox.js';
import {
  createGitHubAppJwt,
  createInstallationToken,
  enforceForkTargetPolicy,
  executeForkCommitAndPushInSandbox,
  githubRequest,
  OperationPreflightError,
  parseForkGithubPayload,
  resolveBranchForFork,
  resolveGitHubInstallationId,
} from './github.js';
import { sanitizeErrorMessage } from './operations-helpers.js';
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

function getArtifactsBucket(env: Env): R2Bucket | null {
  return env.WORKSPACE_ARTIFACTS ?? env.SOURCE_BUNDLES ?? null;
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
  const claimed = await claimWorkspaceOperationForExecution(env.DB, workspace.id, operationId);
  if (!claimed) {
    return;
  }

  let partialForkContext: Record<string, unknown> | null = null;

  try {
    if (type === 'fork_github') {
      const payload = parseForkGithubPayload(requestPayload);
      enforceForkTargetPolicy(env, payload.target.owner);

      const appJwt = await createGitHubAppJwt(env);
      const installationId = await resolveGitHubInstallationId(
        env,
        appJwt,
        payload.target.owner,
        payload.target.repo,
        payload.installationId
      );
      const installationToken = await createInstallationToken(env, appJwt, installationId);

      const repoInfo = await githubRequest<{ default_branch: string }>(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}`,
        { token: installationToken }
      );

      await githubRequest(env, `/repos/${payload.target.owner}/${payload.target.repo}/git/commits/${workspace.commitSha}`, {
        token: installationToken,
      });

      const defaultRef = await githubRequest<{ object: { sha: string } }>(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`,
        { token: installationToken }
      );

      const warnings: Array<Record<string, unknown>> = [];
      if (defaultRef.object.sha !== workspace.commitSha) {
        warnings.push({
          code: 'baseline_stale',
          message: 'Forked from workspace baseline while target default branch has moved',
          details: {
            baselineSha: workspace.commitSha,
            defaultBranch: repoInfo.default_branch,
            defaultBranchHeadSha: defaultRef.object.sha,
          },
        });
      }

      const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
      if (!(await workspaceHasGitHead(sandbox))) {
        throw new OperationPreflightError('baseline_missing', 'Workspace git baseline is missing');
      }

      const oversizedFiles = await listOversizedWorkspaceFiles(sandbox, 100 * 1024 * 1024);
      if (oversizedFiles.length > 0) {
        throw new OperationPreflightError('file_too_large_for_github', 'Workspace contains files over GitHub blob limit', {
          files: oversizedFiles,
        });
      }

      const secretMatches = await detectPotentialSecrets(sandbox);
      if (secretMatches.length > 0) {
        const shouldBlock = (env.BLOCK_ON_SECRET_MATCH ?? 'false').toLowerCase() === 'true';
        if (shouldBlock) {
          throw new OperationPreflightError('secret_match_blocked', 'Potential secrets detected in workspace', {
            files: secretMatches,
          });
        }
        warnings.push({
          code: 'secret_match',
          message: `Potential secret patterns detected in ${secretMatches.length} files`,
          details: { files: secretMatches },
        });
      }

      const hasChanges = await workspaceHasChanges(sandbox);
      if (!hasChanges) {
        throw new OperationPreflightError('no_changes', 'Workspace has no changes to fork');
      }

      const resolvedBranch = await resolveBranchForFork(
        env,
        installationToken,
        payload.target.owner,
        payload.target.repo,
        payload.target.branch,
        workspace.id
      );

      partialForkContext = {
        target: {
          owner: payload.target.owner,
          repo: payload.target.repo,
          branch: resolvedBranch.branch,
        },
      };

      await githubRequest(env, `/repos/${payload.target.owner}/${payload.target.repo}/git/refs`, {
        method: 'POST',
        token: installationToken,
        body: {
          ref: `refs/heads/${resolvedBranch.branch}`,
          sha: workspace.commitSha,
        },
      });

      partialForkContext = {
        ...partialForkContext,
        branchCreated: true,
        branchRef: `refs/heads/${resolvedBranch.branch}`,
      };

      const commitMessage = payload.commit?.message?.trim() || `Apply Nimbus workspace ${workspace.id} changes from ${workspace.commitSha}`;
      const commitSha = await executeForkCommitAndPushInSandbox(sandbox, {
        owner: payload.target.owner,
        repo: payload.target.repo,
        token: installationToken,
        baselineSha: workspace.commitSha,
        branch: resolvedBranch.branch,
        commitMessage,
      });

      await updateWorkspaceOperationStatus(env.DB, operationId, 'succeeded', {
        warnings,
        result: {
          target: {
            owner: payload.target.owner,
            repo: payload.target.repo,
            branch: resolvedBranch.branch,
          },
          branchRef: `refs/heads/${resolvedBranch.branch}`,
          commitSha,
          repoUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}`,
          compareUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}/compare/${encodeURIComponent(
            repoInfo.default_branch
          )}...${encodeURIComponent(resolvedBranch.branch)}`,
        },
      });
      return;
    }

    const artifactsBucket = getArtifactsBucket(env);
    if (!artifactsBucket) {
      throw new Error('No artifact bucket is configured (WORKSPACE_ARTIFACTS or SOURCE_BUNDLES)');
    }

    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    if (type === 'export_patch' && !(await workspaceHasGitHead(sandbox))) {
      throw new Error('Workspace git baseline is missing');
    }

    let contentType = 'text/plain';
    let extension = 'txt';
    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let warnings: Array<Record<string, unknown>> = [];
    const metadata: Record<string, unknown> = {};

    if (type === 'export_patch') {
      const content = await runWorkspaceDiffAgainstHead(sandbox, '');
      bytes = new TextEncoder().encode(content);
      contentType = 'text/x-diff';
      extension = 'patch';

      const binaryNumstat = await runWorkspaceDiffAgainstHead(sandbox, '--numstat -z');
      const binaryFiles: string[] = [];
      const tokens = binaryNumstat.split('\u0000').filter((token) => token.length > 0);
      for (const token of tokens) {
        const parts = token.split('\t');
        if (parts.length === 3 && parts[0] === '-' && parts[1] === '-') {
          binaryFiles.push(parts[2]);
        }
      }
      if (binaryFiles.length > 0) {
        warnings.push({
          code: 'binary_excluded',
          message: `${binaryFiles.length} binary files excluded from patch`,
          details: { files: binaryFiles },
        });
      }
      metadata.binaryExcludedCount = binaryFiles.length;
    } else {
      const zipBase64 = await exportWorkspaceZipBase64(sandbox);
      bytes = fromBase64(zipBase64);
      contentType = 'application/zip';
      extension = 'zip';
      metadata.includesGitMetadata = false;
    }

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const artifactId = generateWorkspaceArtifactId();
    const objectKey = `workspaces/${workspace.id}/artifacts/${artifactId}.${extension}`;
    await artifactsBucket.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        workspace_id: workspace.id,
        operation_id: operationId,
        artifact_type: type === 'export_patch' ? 'patch' : 'zip',
      },
    });

    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + retentionMs).toISOString();
    await createWorkspaceArtifact(env.DB, {
      id: artifactId,
      workspaceId: workspace.id,
      operationId,
      type: type === 'export_patch' ? 'patch' : 'zip',
      objectKey,
      bytes: bytes.byteLength,
      contentType,
      sha256: sha,
      sourceBaselineSha: workspace.commitSha,
      retentionExpiresAt: expiresAt,
      warnings,
      metadata,
    });

    await updateWorkspaceOperationStatus(env.DB, operationId, 'succeeded', {
      result: { artifactId },
      warnings,
    });
  } catch (error) {
    if (error instanceof OperationPreflightError) {
      await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
        errorCode: error.code,
        errorClass: 'preflight_error',
        errorMessage: error.message,
        errorDetails: {
          ...(error.details ?? {}),
          ...(partialForkContext ? { partial: partialForkContext } : {}),
        },
      });
      return;
    }

    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
      errorCode: 'operation_failed',
      errorClass: 'runtime_error',
      errorMessage: message,
      errorDetails: {
        operationType: type,
        ...(partialForkContext ? { partial: partialForkContext } : {}),
      },
    });
  }
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
