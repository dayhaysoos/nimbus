import * as p from '@clack/prompts';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import type { UiServerSession } from './ui-server.js';

export const DEFAULT_OPEN_PORT = 2000;
export const LOCAL_HOST = '127.0.0.1';

type ReviewUiReporter = {
  warning: (message: string) => void;
};

const defaultReporter: ReviewUiReporter = {
  warning: (message) => p.log.warning(message),
};

export interface ReviewUiRuntimeContext {
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}

export function resolveReviewUiRuntimeContext(
  options?: {
    port?: number;
    reporter?: ReviewUiReporter;
  }
): ReviewUiRuntimeContext {
  const reporter = options?.reporter ?? defaultReporter;
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  if (!apiKey) {
    reporter.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  return {
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  };
}

export async function runWithManagedUiSession<T>(
  uiSession: UiServerSession,
  run: (options: { wasInterrupted: () => boolean }) => Promise<T>
): Promise<T | undefined> {
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
    return await run({ wasInterrupted: () => interrupted });
  } catch (error) {
    if (interrupted) {
      return undefined;
    }
    throw error;
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
    p.outro('Report UI stopped.');
  }
}
