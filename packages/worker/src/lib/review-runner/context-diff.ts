import type { Env } from '../../types.js';
import { getWorkspaceArtifactById, getWorkspaceOperation } from '../db.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Resolves the authoritative review diff patch from workspace artifacts or the originating export operation.
 * Returns null when no patch artifact can be recovered.
 */
export async function loadAuthoritativeDeploymentDiff(
  env: Env,
  workspaceId: string,
  operationId: string | null,
  reviewDiffArtifactId: string | null
): Promise<{ source: 'artifact_patch'; artifactId: string; patch: string } | null> {
  const getArtifactObject = async (objectKey: string): Promise<R2ObjectBody | null> => {
    const fromArtifacts = env.WORKSPACE_ARTIFACTS ? await env.WORKSPACE_ARTIFACTS.get(objectKey) : null;
    if (fromArtifacts) {
      return fromArtifacts;
    }
    return env.SOURCE_BUNDLES ? await env.SOURCE_BUNDLES.get(objectKey) : null;
  };

  if (reviewDiffArtifactId) {
    const reviewArtifact = await getWorkspaceArtifactById(env.DB, workspaceId, reviewDiffArtifactId);
    if (reviewArtifact && reviewArtifact.artifact.type === 'patch') {
      const object = await getArtifactObject(reviewArtifact.objectKey);
      if (!object) {
        return null;
      }
      return {
        source: 'artifact_patch',
        artifactId: reviewDiffArtifactId,
        patch: await object.text(),
      };
    }
  }

  if (!operationId) {
    return null;
  }

  const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
  if (!operation || operation.type !== 'export_patch' || operation.status !== 'succeeded') {
    return null;
  }

  const result = asRecord(operation.result);
  const artifactId = typeof result.artifactId === 'string' ? result.artifactId.trim() : '';
  if (!artifactId) {
    return null;
  }

  const artifact = await getWorkspaceArtifactById(env.DB, workspaceId, artifactId);
  if (!artifact || artifact.artifact.type !== 'patch') {
    return null;
  }

  const object = await getArtifactObject(artifact.objectKey);
  if (!object) {
    return null;
  }

  return {
    source: 'artifact_patch',
    artifactId,
    patch: await object.text(),
  };
}
