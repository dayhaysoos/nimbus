import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudioDataSource } from '../../data/studio/StudioDataSource';
import type {
  ReviewSessionResponse,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartStageEvent,
} from '../../types';
import { resolveLaunchState } from './launchViewModel';

const LAST_CHECKPOINTS = 1 as const;
const HOME_REFRESH_INTERVAL_MS = 3_000;

export interface StudioLaunchControllerResult {
  context: StudioContextResponse | null;
  preflight: StudioNewReviewPreflightResponse | null;
  currentSession: ReviewSessionResponse | null;
  loading: boolean;
  error: string | null;
  starting: boolean;
  startStages: StudioNewReviewStartStageEvent[];
  startError: string | null;
  launchState: ReturnType<typeof resolveLaunchState>;
  nextRoutePath: string | null;
  handleStart(): void;
}

export function useStudioLaunchController(): StudioLaunchControllerResult {
  const dataSource = useStudioDataSource();
  const startSubscriptionRef = useRef<{ close(): void } | null>(null);
  const hasLoadedRef = useRef(false);
  const [context, setContext] = useState<StudioContextResponse | null>(null);
  const [preflight, setPreflight] = useState<StudioNewReviewPreflightResponse | null>(null);
  const [currentSession, setCurrentSession] = useState<ReviewSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startStages, setStartStages] = useState<StudioNewReviewStartStageEvent[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [nextRoutePath, setNextRoutePath] = useState<string | null>(null);

  const loadHome = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background === true;
      if (!background) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await dataSource.loadLaunchState({ lastCheckpoints: LAST_CHECKPOINTS });
        setContext(next.context);
        setPreflight(next.preflight);
        setCurrentSession(next.currentSession);
        setError(null);
        hasLoadedRef.current = true;
      } catch (loadError) {
        if (!background || !hasLoadedRef.current) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!background) {
          setLoading(false);
        }
      }
    },
    [dataSource]
  );

  useEffect(() => {
    void loadHome();
    return () => {
      startSubscriptionRef.current?.close();
      startSubscriptionRef.current = null;
    };
  }, [loadHome]);

  useEffect(() => {
    const refresh = (): void => {
      if (starting) {
        return;
      }
      void loadHome({ background: true });
    };
    const interval = window.setInterval(refresh, HOME_REFRESH_INTERVAL_MS);
    const handleFocus = (): void => refresh();
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadHome, starting]);

  const handleStart = useCallback(() => {
    if (!context?.repo || !context.branch) {
      setStartError('Studio could not detect the current repository and branch.');
      return;
    }
    startSubscriptionRef.current?.close();
    setStarting(true);
    setStartError(null);
    setStartStages([]);
    setNextRoutePath(null);

    startSubscriptionRef.current = dataSource.startSession(
      {
        repo: context.repo,
        branch: context.branch,
        lastCheckpoints: LAST_CHECKPOINTS,
        policyMode: 'auto',
      },
      {
        onEvent(event) {
          if (event.type === 'stage') {
            setStartStages((current) => {
              const next = [...current];
              const existingIndex = next.findIndex((entry) => entry.stage === event.stage);
              if (existingIndex >= 0) {
                next.splice(existingIndex, 1, event);
                return next;
              }
              return [...next, event];
            });
            return;
          }
          if (event.type === 'completed') {
            setStarting(false);
            setNextRoutePath(event.routePath);
            startSubscriptionRef.current?.close();
            startSubscriptionRef.current = null;
            return;
          }
          setStarting(false);
          setStartError(event.message);
        },
        onError(startFailure) {
          setStarting(false);
          setStartError(startFailure.message);
        },
      }
    );
  }, [context?.branch, context?.repo, dataSource]);

  const hasRepoContext = Boolean(context?.repo && context?.branch);
  const launchState = resolveLaunchState({
    loading,
    starting,
    hasRepoContext,
    preflight,
    error,
  });

  return {
    context,
    preflight,
    currentSession,
    loading,
    error,
    starting,
    startStages,
    startError,
    launchState,
    nextRoutePath,
    handleStart,
  };
}
