import * as p from '@clack/prompts';
import { deriveReviewPolicy, getReview, getWorkerUrl, streamReviewEvents } from '../../lib/api.js';
import { formatEvent } from '../../commands/review/events.js';
import { resolveReviewContext } from './create-from-commit.js';
import { openBrowser, startReportUiSession } from './ui-server.js';

const DEFAULT_OPEN_PORT = 2000;
const LOCAL_HOST = '127.0.0.1';

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
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  const context = await resolveReviewContext({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
  });

  p.log.message(`Starting policy derivation for workspace ${context.workspaceId}, deployment ${context.deploymentId}`);
  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId: context.workspaceId,
    deploymentId: context.deploymentId,
    provenance: context.resolvedProvenance,
  });

  const uiSession = await startReportUiSession({
    routePath: `/policy/${encodeURIComponent(derived.reviewId)}`,
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });
  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Streaming review events; press Ctrl+C to stop.');

  let terminalStatus: string | null = null;
  let interrupted = false;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await uiSession.close().catch(() => undefined);
  };
  const handleSignal = () => {
    interrupted = true;
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    const proxyWorkerUrl = `http://${LOCAL_HOST}:${port}`;
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

    if (interrupted) {
      return;
    }

    const final = await getReview(proxyWorkerUrl, derived.reviewId);
    const status = terminalStatus ?? final.review.status;
    if (status === 'succeeded') {
      p.log.success(`Review completed: ${status}`);
    } else {
      p.log.warning(`Review completed: ${status}`);
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
    p.outro('Report UI stopped.');
  }
}

export async function startReviewUiCommand(options?: StartReviewUiOptions): Promise<void> {
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;

  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  const uiSession = await startReportUiSession({
    routePath: '/',
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });

  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Report UI server running; press Ctrl+C to stop.');

  let interrupted = false;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await uiSession.close().catch(() => undefined);
  };
  const handleSignal = () => {
    interrupted = true;
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await uiSession.waitForExit();
  } catch (error) {
    if (!interrupted) {
      throw error;
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
    p.outro('Report UI stopped.');
  }
}
