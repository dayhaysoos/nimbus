import {
  parseListReviewSessionsResponse,
  parseLocalReviewEnvironmentDiffResponse,
  parseLocalReviewEnvironmentMergeBackResponse,
  parseStudioAdoptResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartStreamEvent,
  parseStudioSessionActivityEvent,
  parseStudioSessionAggregateResponse,
} from '../../lib/review';
import type { ReviewSessionResponse, StudioSessionAggregateResponse } from '../../types';
import type { StudioDataSource, StudioDataSubscription, StudioLaunchState } from './StudioDataSource';

const REVIEWED_DIFF_MAX_BYTES = 200_000;

function isTerminalPhase(phase: ReviewSessionResponse['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function pickCurrentCommitSession(
  sessions: ReviewSessionResponse[],
  commitSha: string | null | undefined
): ReviewSessionResponse | null {
  if (!commitSha) {
    return null;
  }
  return (
    sessions
      .filter((session) => session.anchorCommitSha === commitSha)
      .slice()
      .sort((left, right) => {
        const terminalDelta = Number(isTerminalPhase(left.phase)) - Number(isTerminalPhase(right.phase));
        if (terminalDelta !== 0) {
          return terminalDelta;
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      })[0] ?? null
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readErrorMessage(payload: unknown): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (error && typeof error === 'object' && !Array.isArray(error) && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
  }
  return 'Request failed.';
}

async function fetchParsed<T>(input: string, parse: (payload: unknown) => T, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload));
  }
  return parse(payload);
}

export function createRealStudioDataSource(apiBase: string): StudioDataSource {
  return {
    async loadLaunchState(input): Promise<StudioLaunchState> {
      const [context, preflight] = await Promise.all([
        fetchParsed(`${apiBase}/api/studio/context`, parseStudioContextResponse),
        fetchParsed(
          `${apiBase}/api/studio/new-review/preflight?lastCheckpoints=${input.lastCheckpoints}`,
          parseStudioNewReviewPreflightResponse
        ),
      ]);

      if (!context.repo || !context.branch) {
        return {
          context,
          preflight,
          currentSession: null,
        };
      }

      const sessions = await fetchParsed(
        `${apiBase}/api/review-sessions?limit=20&repo=${encodeURIComponent(context.repo)}&branch=${encodeURIComponent(context.branch)}`,
        parseListReviewSessionsResponse
      );

      return {
        context,
        preflight,
        currentSession: pickCurrentCommitSession(sessions.sessions, preflight.commitSha),
      };
    },

    startSession(input, observer): StudioDataSubscription {
      const params = new URLSearchParams({
        repo: input.repo,
        branch: input.branch,
        policyMode: input.policyMode,
        lastCheckpoints: String(input.lastCheckpoints),
      });

      const source = new EventSource(`${apiBase}/api/studio/new-review/start/events?${params.toString()}`);

      const handleMessage = (messageEvent: MessageEvent<string>): void => {
        try {
          const event = parseStudioNewReviewStartStreamEvent(JSON.parse(messageEvent.data) as unknown);
          observer.onEvent(event);
        } catch (error) {
          observer.onError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const handleError = (): void => {
        observer.onError(new Error('The launch stream disconnected before Nimbus could start the session.'));
      };

      source.addEventListener('message', handleMessage);
      source.addEventListener('error', handleError);

      return {
        close(): void {
          source.close();
        },
      };
    },

    async loadSession(sessionId: string): Promise<StudioSessionAggregateResponse> {
      return fetchParsed(
        `${apiBase}/api/studio/sessions/${encodeURIComponent(sessionId)}?includeReviewedDiff=1&includePatch=1&maxBytes=${REVIEWED_DIFF_MAX_BYTES}`,
        parseStudioSessionAggregateResponse
      );
    },

    subscribeToSessionActivity(aggregate, observer): StudioDataSubscription | null {
      if (!aggregate.activity.canStream || isTerminalPhase(aggregate.session.phase)) {
        return null;
      }

      const source = new EventSource(`${apiBase}${aggregate.paths.activityEvents}`);
      const handleMessage = (messageEvent: MessageEvent<string>): void => {
        try {
          const event = parseStudioSessionActivityEvent(JSON.parse(messageEvent.data) as unknown);
          observer.onEvent(event);
        } catch (error) {
          observer.onError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const handleError = (): void => {
        observer.onError(new Error('The live session stream disconnected. Refresh the page to reconnect.'));
      };

      source.addEventListener('message', handleMessage);
      source.addEventListener('error', handleError);

      return {
        close(): void {
          source.close();
        },
      };
    },

    async approvePolicy(input): Promise<void> {
      await fetchParsed(
        `${apiBase}/api/reviews/${encodeURIComponent(input.reviewId)}/policy/approve`,
        () => undefined,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            approvedPolicy: input.approvedPolicy,
          }),
        }
      );
    },

    async adoptSession(input) {
      return fetchParsed(`${apiBase}${input.path}`, parseStudioAdoptResponse, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: input.mode }),
      });
    },

    async loadLocalDiff(path) {
      return fetchParsed(`${apiBase}${path}`, parseLocalReviewEnvironmentDiffResponse);
    },

    async mergeBack(path) {
      return fetchParsed(`${apiBase}${path}`, parseLocalReviewEnvironmentMergeBackResponse, {
        method: 'POST',
      });
    },
  };
}
