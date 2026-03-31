import { appendWorkspaceEvent, markWorkspaceReady } from '../../lib/db.js';
import type { Env } from '../../types.js';
import { ensureWorkspaceGitBaseline } from './sandbox-git.js';
import {
  getWorkspaceSandbox,
  hydrateWorkspaceFilesystem,
} from './sandbox.js';

export class WorkspaceReadyTransitionError extends Error {
  constructor(message = 'Workspace can no longer transition to ready (likely deleted)') {
    super(message);
    this.name = 'WorkspaceReadyTransitionError';
  }
}

export async function hydrateWorkspaceToReady(
  env: Env,
  workspaceId: string,
  sandboxId: string,
  sourceBytes: ArrayBuffer
): Promise<{ baselineReady: boolean }> {
  let baselineReady = true;

  await hydrateWorkspaceFilesystem(env, sandboxId, sourceBytes);
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
    throw new WorkspaceReadyTransitionError();
  }

  return { baselineReady };
}
