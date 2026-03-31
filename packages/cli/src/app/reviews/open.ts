import * as p from '@clack/prompts';
import { deriveReviewPolicy, getReview, streamReviewEvents } from '../../clients/worker/reviews.js';
import { formatEvent } from '../../commands/review/events.js';
import { resolveReviewContext } from './context.js';
import { DEFAULT_OPEN_PORT, LOCAL_HOST, resolveReviewUiRuntimeContext, runWithManagedUiSession } from './session.js';
import { openBrowser, startReportUiSession } from './ui-server.js';

export interface OpenReviewFromCommitOptions {
  port?: number;
  commitish?: string;
  baseRef?: string;
  projectRoot?: string;
  idempotencyKey?: string;
  pollIntervalMs?: number;
}

export interface StartReviewUiOptions {
  port?: number;
}

export async function openReviewFromCommitCommand(options?: OpenReviewFromCommitOptions): Promise<void> {
  const runtime = resolveReviewUiRuntimeContext({ port: options?.port });

  const context = await resolveReviewContext({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
  });

  p.log.message(`Starting policy derivation for workspace ${context.workspaceId}, deployment ${context.deploymentId}`);
  const derived = await deriveReviewPolicy(runtime.workerUrl, {
    workspaceId: context.workspaceId,
    deploymentId: context.deploymentId,
    provenance: context.resolvedProvenance,
  });

  const uiSession = await startReportUiSession({
    routePath: `/policy/${encodeURIComponent(derived.reviewId)}`,
    port: runtime.port,
    workerUrl: runtime.workerUrl,
    apiKey: runtime.apiKey,
    reviewGithubToken: runtime.reviewGithubToken,
    openrouterApiKey: runtime.openrouterApiKey,
  });
  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Streaming review events; press Ctrl+C to stop.');

  let terminalStatus: string | null = null;
  await runWithManagedUiSession(uiSession, async ({ wasInterrupted, waitForInterrupt }) => {
    const proxyWorkerUrl = `http://${LOCAL_HOST}:${runtime.port}`;
    await Promise.race([
      streamReviewEvents(proxyWorkerUrl, derived.reviewId, async (event) => {
        const line = formatEvent(event);
        if (line) {
          console.log(line);
        }
        if (event.data.type === 'terminal' && typeof event.data.status === 'string') {
          terminalStatus = event.data.status;
        }
      }),
      uiSession.waitForExit(),
    ]);

    if (wasInterrupted()) {
      return;
    }

    const final = await getReview(proxyWorkerUrl, derived.reviewId);
    const status = terminalStatus ?? final.review.status;
    if (status === 'succeeded') {
      p.log.success(`Review completed: ${status}`);
    } else {
      p.log.warning(`Review completed: ${status}`);
    }

    p.log.message('Report UI server is still running; press Ctrl+C to stop.');
    await Promise.race([uiSession.waitForExit(), waitForInterrupt()]);
  });
}

export async function startReviewUiCommand(options?: StartReviewUiOptions): Promise<void> {
  const runtime = resolveReviewUiRuntimeContext({ port: options?.port });

  const uiSession = await startReportUiSession({
    routePath: '/',
    port: runtime.port,
    workerUrl: runtime.workerUrl,
    apiKey: runtime.apiKey,
    reviewGithubToken: runtime.reviewGithubToken,
    openrouterApiKey: runtime.openrouterApiKey,
  });

  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Report UI server running; press Ctrl+C to stop.');

  await runWithManagedUiSession(uiSession, async () => {
    await uiSession.waitForExit();
  });
}
