import * as p from '@clack/prompts';
import {
  ensureReviewStudioRuntime,
  getReviewStudioRuntimeStatus,
  resolveReviewUiRuntimeContext,
  runStudioServeProcess,
  stopReviewStudioRuntime,
} from './session.js';
import { openBrowser } from './ui-server.js';

export interface OpenReviewFromCommitOptions {
  port?: number;
  commitish?: string;
  baseRef?: string;
  projectRoot?: string;
  idempotencyKey?: string;
  pollIntervalMs?: number;
}

export interface StartReviewStudioOptions {
  port?: number;
  routePath?: string;
  serve?: boolean;
  status?: boolean;
  stop?: boolean;
}

export async function openReviewFromCommitCommand(options?: OpenReviewFromCommitOptions): Promise<void> {
  p.log.warning('`nimbus review open` is a compatibility path. Use `nimbus review studio` + `nimbus review create`.');
  const reviewModule = await import('./create-from-commit.js');
  await reviewModule.createReviewFromCommitCommand({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
    policyMode: 'review',
    openStudio: true,
    openStudioPort: options?.port,
  });
}

export async function startReviewStudioCommand(options?: StartReviewStudioOptions): Promise<void> {
  if (options?.serve) {
    const runtime = resolveReviewUiRuntimeContext({ port: options.port });
    await runStudioServeProcess(runtime);
    return;
  }

  const runtime = resolveReviewUiRuntimeContext({ port: options?.port });
  if (options?.status) {
    const studioStatus = await getReviewStudioRuntimeStatus(runtime);
    if (studioStatus.running) {
      p.log.success(`Studio runtime is running at ${studioStatus.appUrl}`);
      if (studioStatus.runtime) {
        p.log.message(`PID: ${studioStatus.runtime.pid}`);
        p.log.message(`Started: ${studioStatus.runtime.startedAt}`);
      }
      return;
    }
    if (studioStatus.stale) {
      p.log.warning('Studio runtime metadata exists but runtime is not healthy.');
      return;
    }
    p.log.warning('Studio runtime is not running.');
    return;
  }

  if (options?.stop) {
    const stopped = await stopReviewStudioRuntime(runtime);
    if (stopped.stopped) {
      p.log.success('Stopped Studio runtime.');
      return;
    }
    if (stopped.stale) {
      p.log.warning('Studio runtime was stale. Cleared runtime metadata.');
      return;
    }
    p.log.warning('No running Studio runtime found for this repository.');
    return;
  }

  const routePath = options?.routePath ?? '/';
  const studio = await ensureReviewStudioRuntime(runtime, { routePath });
  openBrowser(studio.appUrl);
  p.log.success(`Opened ${studio.appUrl}`);
  p.log.message(studio.reused ? 'Reused existing Studio runtime.' : 'Started Studio runtime.');
}
