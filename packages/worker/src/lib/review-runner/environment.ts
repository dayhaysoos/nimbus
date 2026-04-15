import type { Env, ReviewContextDiffHunk, ReviewEnvironmentRevision, WorkspaceResponse } from '../../types.js';
import { runWorkspaceDiffAgainstHead, workspaceHasGitHead } from '../../api/workspaces/sandbox-git.js';
import { hydrateWorkspaceToReady } from '../../api/workspaces/ready.js';
import { loadVerifiedWorkspaceSourceBundle } from '../../api/workspaces/source-bundle.js';
import { parseChangedPathsFromDiff, parseDiffHunks } from './context-helpers.js';
import { ReviewContextAssemblyError } from './cochange.js';
import { resolveReviewSandbox } from '../review-analysis/sandbox.js';

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface WorkspaceEnvironmentSnapshot {
  patch: string;
  changedPaths: string[];
  diffHunks: ReviewContextDiffHunk[];
  revision: ReviewEnvironmentRevision;
}

async function ensureWorkspaceEnvironmentBaseline(
  env: Env,
  workspace: Pick<WorkspaceResponse, 'id' | 'status' | 'sandboxId' | 'baselineReady' | 'sourceBundleKey' | 'sourceBundleSha256'>
): Promise<void> {
  if (!workspace.sourceBundleKey || !workspace.sourceBundleSha256) {
    throw new ReviewContextAssemblyError(
      'review_context_environment_baseline_missing',
      `Environment-backed review requires a source bundle for workspace ${workspace.id}. Run workspace reset and try again.`
    );
  }

  const sourceBytesOrResponse = await loadVerifiedWorkspaceSourceBundle(env, workspace);
  if (sourceBytesOrResponse instanceof Response) {
    let message = `Environment-backed review could not reload source bundle for workspace ${workspace.id}.`;
    try {
      const payload = (await sourceBytesOrResponse.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) {
        message = payload.error.trim();
      }
    } catch {
      // Fall back to the generic message above.
    }
    throw new ReviewContextAssemblyError('review_context_environment_baseline_missing', message);
  }

  await hydrateWorkspaceToReady(env, workspace.id, workspace.sandboxId, sourceBytesOrResponse);
}

export async function captureWorkspaceEnvironmentSnapshot(
  env: Env,
  workspace: Pick<WorkspaceResponse, 'id' | 'status' | 'sandboxId' | 'baselineReady' | 'sourceBundleKey' | 'sourceBundleSha256'>
): Promise<WorkspaceEnvironmentSnapshot> {
  if (workspace.status !== 'ready') {
    throw new ReviewContextAssemblyError(
      'review_context_environment_not_ready',
      `Workspace ${workspace.id} must be ready before running an environment-backed review.`
    );
  }
  let sandbox = await resolveReviewSandbox(env, workspace.sandboxId);
  let hasHead = await workspaceHasGitHead(sandbox as never);
  if (!hasHead) {
    await ensureWorkspaceEnvironmentBaseline(env, workspace);
    sandbox = await resolveReviewSandbox(env, workspace.sandboxId);
    hasHead = await workspaceHasGitHead(sandbox as never);
    if (!hasHead) {
      throw new ReviewContextAssemblyError(
        'review_context_environment_baseline_missing',
        `Environment-backed review requires git HEAD in workspace ${workspace.id}. Run workspace reset and try again.`
      );
    }
  }

  const patch = await runWorkspaceDiffAgainstHead(sandbox as never, '');
  const changedPaths = patch ? parseChangedPathsFromDiff(patch) : [];
  const diffHunks = patch ? parseDiffHunks(patch) : [];

  return {
    patch,
    changedPaths,
    diffHunks,
    revision: {
      source: 'workspace_head',
      diffSha256: await sha256Hex(patch),
      changedFileCount: changedPaths.length,
      generatedAt: new Date().toISOString(),
    },
  };
}
