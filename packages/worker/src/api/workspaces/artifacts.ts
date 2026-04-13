import type { AuthContext, Env } from '../../types.js';
import { getWorkspaceArtifactById, listWorkspaceArtifacts } from '../../lib/db.js';
import { jsonResponse, requireWorkspaceAccess, resolveWorkspaceOr404 } from './shared.js';

function getArtifactsBucket(env: Env): R2Bucket | null {
  return env.WORKSPACE_ARTIFACTS ?? env.SOURCE_BUNDLES ?? null;
}

function getArtifactDownloadSecret(env: Env): string | null {
  const value = (env.WORKSPACE_ARTIFACT_DOWNLOAD_SECRET ?? '').trim();
  return value.length > 0 ? value : null;
}

async function signArtifactDownload(
  workspaceId: string,
  artifactId: string,
  expiresAtEpochSec: number,
  secret: string
): Promise<string> {
  const payload = `${workspaceId}:${artifactId}:${expiresAtEpochSec}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  let binary = '';
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function handleListWorkspaceArtifacts(
  workspaceId: string,
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

    const now = new Date();
    const downloadWindowMs = 15 * 60 * 1000;
    const downloadSecret = getArtifactDownloadSecret(env);
    const artifacts = await listWorkspaceArtifacts(env.DB, workspaceId, 100);
    const normalized = await Promise.all(
      artifacts.map(async (artifact) => {
        const expired = artifact.expiresAt <= now.toISOString();
        if (expired || !downloadSecret) {
          return {
            ...artifact,
            status: expired ? 'expired' : artifact.status,
            download: null,
          };
        }

        const expiresAtEpochSec = Math.floor(
          Math.min(Date.parse(artifact.expiresAt), now.getTime() + downloadWindowMs) / 1000
        );
        const signature = await signArtifactDownload(workspaceId, artifact.id, expiresAtEpochSec, downloadSecret);
        return {
          ...artifact,
          status: artifact.status,
          download: {
            url: `/api/workspaces/${workspaceId}/artifacts/${artifact.id}/download?exp=${expiresAtEpochSec}&sig=${encodeURIComponent(
              signature
            )}`,
            expiresAt: new Date(expiresAtEpochSec * 1000).toISOString(),
          },
        };
      })
    );

    return jsonResponse({ artifacts: normalized });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleDownloadWorkspaceArtifact(
  workspaceId: string,
  artifactId: string,
  request: Request,
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

    const artifact = await getWorkspaceArtifactById(env.DB, workspaceId, artifactId);
    if (!artifact) {
      return jsonResponse({ error: 'Artifact not found' }, 404);
    }

    const downloadSecret = getArtifactDownloadSecret(env);
    const allowsAuthenticatedDownload = Boolean(authContext && (!authContext.isHostedMode || authContext.isAuthenticated || authContext.isAdmin));
    const url = new URL(request.url);
    const expRaw = url.searchParams.get('exp');
    const sigRaw = url.searchParams.get('sig');
    const hasSignedDownloadParams = Boolean(expRaw && sigRaw);

    if (hasSignedDownloadParams) {
      if (!downloadSecret) {
        return jsonResponse({ error: 'Artifact download signing is not configured' }, 500);
      }

      const exp = Number(expRaw);
      if (!Number.isFinite(exp) || !sigRaw) {
        return jsonResponse({ error: 'Missing or invalid download signature' }, 403);
      }

      const nowEpochSec = Math.floor(Date.now() / 1000);
      if (exp < nowEpochSec) {
        return jsonResponse({ error: 'Download signature expired' }, 403);
      }

      const expectedSig = await signArtifactDownload(workspaceId, artifactId, exp, downloadSecret);
      if (sigRaw !== expectedSig) {
        return jsonResponse({ error: 'Download signature invalid' }, 403);
      }
    } else if (!allowsAuthenticatedDownload) {
      return jsonResponse({ error: 'Missing or invalid download signature' }, 403);
    }

    const nowIso = new Date().toISOString();
    if (artifact.retentionExpiresAt <= nowIso || artifact.status === 'expired') {
      return jsonResponse(
        {
          error: {
            code: 'artifact_expired',
            message: 'Artifact has expired. Regenerate using the export endpoint with a new idempotency key.',
          },
        },
        410
      );
    }

    const bucket = getArtifactsBucket(env);
    if (!bucket) {
      return jsonResponse({ error: 'Artifact bucket is not configured' }, 500);
    }

    const object = await bucket.get(artifact.objectKey);
    if (!object || !object.body) {
      return jsonResponse({ error: 'Artifact object not found' }, 404);
    }

    const extension = artifact.artifact.type === 'zip' ? 'zip' : 'patch';
    const filename = `${artifact.artifact.id}.${extension}`;
    return new Response(object.body, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Nimbus-Api-Key',
        'Content-Type': artifact.contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}
