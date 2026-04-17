import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type {
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentMergeBackResponse,
  ReviewPolicyDraft,
  ReviewSessionResponse,
  StudioAdoptResponse,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartStreamEvent,
  StudioPolicyMode,
  StudioSessionActivityEvent,
  StudioSessionAggregateResponse,
} from '../../types';

export interface StudioLaunchState {
  context: StudioContextResponse | null;
  preflight: StudioNewReviewPreflightResponse | null;
  currentSession: ReviewSessionResponse | null;
}

export interface StudioDataSubscription {
  close(): void;
}

export interface StudioDataSource {
  loadLaunchState(input: { lastCheckpoints: 1 | 2 | 3 }): Promise<StudioLaunchState>;
  startSession(
    input: {
      repo: string;
      branch: string;
      lastCheckpoints: 1 | 2 | 3;
      policyMode: StudioPolicyMode;
    },
    observer: {
      onEvent(event: StudioNewReviewStartStreamEvent): void;
      onError(error: Error): void;
    }
  ): StudioDataSubscription;
  loadSession(sessionId: string): Promise<StudioSessionAggregateResponse>;
  subscribeToSessionActivity(
    aggregate: StudioSessionAggregateResponse,
    observer: {
      onEvent(event: StudioSessionActivityEvent): void;
      onError(error: Error): void;
    }
  ): StudioDataSubscription | null;
  approvePolicy(input: { reviewId: string; approvedPolicy: ReviewPolicyDraft }): Promise<void>;
  adoptSession(input: { path: string; mode: 'worktree' | 'branch' }): Promise<StudioAdoptResponse>;
  loadLocalDiff(path: string): Promise<LocalReviewEnvironmentDiffResponse>;
  mergeBack(path: string): Promise<LocalReviewEnvironmentMergeBackResponse>;
}

const StudioDataSourceContext = createContext<StudioDataSource | null>(null);

export function StudioDataSourceProvider(props: { value: StudioDataSource; children: ReactNode }): JSX.Element {
  return <StudioDataSourceContext.Provider value={props.value}>{props.children}</StudioDataSourceContext.Provider>;
}

export function useStudioDataSource(): StudioDataSource {
  const value = useContext(StudioDataSourceContext);
  if (!value) {
    throw new Error('StudioDataSourceProvider is missing.');
  }
  return value;
}
