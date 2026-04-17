import type { StudioNewReviewPreflightResponse } from '../../types';

export type LaunchState = 'checking' | 'ready' | 'basic' | 'blocked' | 'starting';

export function resolveLaunchState(input: {
  loading: boolean;
  starting: boolean;
  hasRepoContext: boolean;
  preflight: StudioNewReviewPreflightResponse | null;
  error: string | null;
}): LaunchState {
  if (input.starting) {
    return 'starting';
  }
  if (input.loading && !input.preflight && !input.error) {
    return 'checking';
  }
  if (!input.hasRepoContext) {
    return 'blocked';
  }
  if (input.preflight?.startability === 'intent_aware') {
    return 'ready';
  }
  if (input.preflight?.startability === 'basic') {
    return 'basic';
  }
  if (input.preflight?.startability === 'blocked' || input.error) {
    return 'blocked';
  }
  return 'checking';
}

export function launchStateLabel(state: LaunchState): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'basic':
      return 'Basic mode';
    case 'blocked':
      return 'Blocked';
    case 'starting':
      return 'Starting';
    default:
      return 'Checking';
  }
}

export function launchSupportCopy(
  state: LaunchState,
  input: {
    hasRepoContext: boolean;
    preflight: StudioNewReviewPreflightResponse | null;
    error: string | null;
  }
): string | null {
  if (state === 'basic') {
    return 'Entire context is unavailable. Nimbus can still review the latest commit in basic mode.';
  }
  if (state === 'starting') {
    return 'Nimbus is resolving the latest commit and opening the session.';
  }
  if (state === 'blocked') {
    if (!input.hasRepoContext) {
      return 'Open Review Studio from inside a git repository.';
    }
    if (!input.preflight?.commitSha) {
      return 'Make a commit to start a review.';
    }
    return (
      input.preflight?.blockingIssues[0]?.message ??
      input.preflight?.error?.message ??
      input.error ??
      'Nimbus could not resolve a reviewable latest commit.'
    );
  }
  return null;
}

export function modeLabel(preflight: StudioNewReviewPreflightResponse | null): string {
  if (!preflight) {
    return 'Checking';
  }
  if (preflight.startability === 'intent_aware') {
    return 'Found';
  }
  if (preflight.startability === 'basic') {
    return 'Unavailable';
  }
  return 'Checking';
}

export function preflightSignalLabel(state: LaunchState): string {
  switch (state) {
    case 'ready':
    case 'basic':
      return 'Ready';
    case 'blocked':
      return 'Blocked';
    case 'starting':
      return 'Starting';
    default:
      return 'Checking';
  }
}
