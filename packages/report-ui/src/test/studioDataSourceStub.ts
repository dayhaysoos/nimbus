import type {
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentMergeBackResponse,
  ReviewPolicyDraft,
  StudioAdoptResponse,
  StudioSessionAggregateResponse,
} from '../types';
import type { StudioDataSource, StudioLaunchState } from '../data/studio/StudioDataSource';

function noOpSubscription() {
  return {
    close(): void {},
  };
}

export function createStubStudioDataSource(overrides: Partial<StudioDataSource> = {}): StudioDataSource {
  return {
    async loadLaunchState(): Promise<StudioLaunchState> {
      return {
        context: null,
        preflight: null,
        currentSession: null,
      };
    },
    startSession() {
      return noOpSubscription();
    },
    async loadSession(): Promise<StudioSessionAggregateResponse> {
      throw new Error('loadSession stub not implemented.');
    },
    subscribeToSessionActivity() {
      return null;
    },
    async approvePolicy(_input: { reviewId: string; approvedPolicy: ReviewPolicyDraft }): Promise<void> {},
    async adoptSession(): Promise<StudioAdoptResponse> {
      throw new Error('adoptSession stub not implemented.');
    },
    async loadLocalDiff(): Promise<LocalReviewEnvironmentDiffResponse> {
      throw new Error('loadLocalDiff stub not implemented.');
    },
    async mergeBack(): Promise<LocalReviewEnvironmentMergeBackResponse> {
      throw new Error('mergeBack stub not implemented.');
    },
    ...overrides,
  };
}
