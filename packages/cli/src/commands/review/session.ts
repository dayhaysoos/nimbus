import * as p from '@clack/prompts';
import { getReviewSession, listReviewSessions } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { resetWorkspace } from '../../clients/worker/workspaces.js';
import {
  diffLocalReviewEnvironmentCommand,
  listLocalReviewEnvironmentsCommand,
  printEnterLocalReviewEnvironmentCommand,
  printLocalReviewEnvironmentPathCommand,
  setLocalReviewEnvironmentFlowForTests,
} from '../../app/reviews/local-environments.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import { printReviewSessionOutcome } from '../../app/reviews/session-outcome.js';
import type { ReviewEnvironmentRevision, ReviewRunStatus, ReviewSessionResponse } from '../../lib/types.js';

function isActiveReviewStatus(status: ReviewRunStatus | null): boolean {
  return status === 'policy_pending' || status === 'policy_ready' || status === 'policy_approved' || status === 'queued' || status === 'running';
}

function formatEnvironmentRevision(revision: ReviewEnvironmentRevision | undefined): string | null {
  if (!revision) {
    return null;
  }

  return `${revision.diffSha256.slice(0, 12)} (${revision.changedFileCount} changed files)`;
}

function formatRelativeTime(isoTimestamp: string): string {
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) {
    return isoTimestamp;
  }

  const diffMs = then - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (absSeconds < 60) {
    return rtf.format(Math.round(diffMs / 1000), 'second');
  }
  const absMinutes = absSeconds / 60;
  if (absMinutes < 60) {
    return rtf.format(Math.round(diffMs / (60 * 1000)), 'minute');
  }
  const absHours = absMinutes / 60;
  if (absHours < 24) {
    return rtf.format(Math.round(diffMs / (60 * 60 * 1000)), 'hour');
  }
  const absDays = absHours / 24;
  if (absDays < 7) {
    return rtf.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), 'day');
  }
  if (absDays < 30) {
    return rtf.format(Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)), 'week');
  }
  if (absDays < 365) {
    return rtf.format(Math.round(diffMs / (30 * 24 * 60 * 60 * 1000)), 'month');
  }
  return rtf.format(Math.round(diffMs / (365 * 24 * 60 * 60 * 1000)), 'year');
}

function formatContextMode(mode: 'basic' | 'intent_aware' | 'unknown' | null): string {
  if (mode === 'intent_aware') {
    return 'intent-aware';
  }
  if (mode === 'basic') {
    return 'basic';
  }
  return 'unknown';
}

function resolveSessionScope(options?: { all?: boolean }): { repo?: string; branch?: string } {
  if (options?.all) {
    return {};
  }

  let repo: string | undefined;
  let branch: string | undefined;

  try {
    repo = detectRepoSlugFromGitOrigin();
  } catch {
    repo = undefined;
  }

  try {
    branch = new GitRepo(process.cwd()).getCurrentBranchRef() ?? undefined;
  } catch {
    branch = undefined;
  }

  return {
    ...(repo ? { repo } : {}),
    ...(repo && branch ? { branch } : {}),
  };
}

function printSessionList(sessions: ReviewSessionResponse[], options?: { all?: boolean; limit?: number }): void {
  if (sessions.length === 0) {
    p.log.warning(
      options?.all
        ? 'No review sessions found.'
        : 'No review sessions found for the current repo/branch.'
    );
    return;
  }

  p.log.info(options?.all ? 'Review sessions' : 'Review sessions for the current repo/branch');
  console.log('');
  sessions.forEach((session, index) => {
    const contextMode = formatContextMode(session.outcome?.reviewed.contextMode ?? null);
    const materializeReady = session.outcome?.materializeReady ? 'ready' : 'not ready';
    console.log(
      `  ${index + 1}. ${session.id}  ${session.phase}  ${formatRelativeTime(session.updatedAt)}  ${session.passCount} passes`
    );
    console.log(`     repo   ${session.repo}`);
    console.log(`     branch ${session.branch}`);
    console.log(`     stop   ${session.stopReason ?? 'active'}`);
    console.log(`     mode   ${contextMode}`);
    console.log(`     latest ${session.latestReviewId ?? 'none'}  adopt ${materializeReady}`);
  });
}

function printSessionDetails(session: ReviewSessionResponse): void {
  p.log.info(`Review session ${session.id}`);
  console.log('');
  console.log(`  Phase:           ${session.phase}`);
  console.log(`  Workspace ID:    ${session.workspaceId}`);
  console.log(`  Anchor Deploy:   ${session.anchorDeploymentId}`);
  console.log(`  Repo:            ${session.repo}`);
  console.log(`  Branch:          ${session.branch}`);
  console.log(`  Initial Basis:   ${session.initialReviewBasis}`);
  console.log(`  Anchor Commit:   ${session.anchorCommitSha ?? 'none'}`);
  console.log(`  Checkpoint ID:   ${session.anchorCheckpointId ?? 'none'}`);
  console.log(`  Project Root:    ${session.sourceProjectRoot ?? '.'}`);
  console.log(`  Active Review:   ${session.activeReviewId ?? 'none'}`);
  console.log(`  Latest Review:   ${session.latestReviewId ?? 'none'}`);
  console.log(`  Current Status:  ${session.currentReviewStatus ?? 'none'}`);
  console.log(`  Stop Reason:     ${session.stopReason ?? 'active'}`);
  console.log(`  Pass Count:      ${session.passCount}`);
  console.log(`  Created At:      ${session.createdAt}`);
  console.log(`  Updated At:      ${session.updatedAt}`);
  console.log(`  Finished At:     ${session.finishedAt ?? 'none'}`);

  printReviewSessionOutcome(session, { detailed: true });

  if (session.passes.length > 0) {
    console.log('');
    console.log('  Passes:');
    session.passes.forEach((pass, index) => {
      console.log(`    ${index + 1}. ${pass.reviewId} ${pass.status} ${pass.reviewBasis}`);
      const environmentRevision = formatEnvironmentRevision(pass.environmentRevision);
      if (environmentRevision) {
        console.log(`       env ${environmentRevision}`);
      }
      console.log(`       created ${pass.createdAt}`);
      if (pass.startedAt) {
        console.log(`       started ${pass.startedAt}`);
      }
      if (pass.finishedAt) {
        console.log(`       finished ${pass.finishedAt}`);
      }
    });
  }
}

export async function showReviewSessionCommand(sessionId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const { session } = await getReviewSession(workerUrl, sessionId);
  printSessionDetails(session);
}

export async function listReviewSessionsCommand(options?: { all?: boolean; limit?: number }): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const { repo, branch } = resolveSessionScope({ all: options?.all });
  if (!options?.all && !repo) {
    throw new Error('Unable to resolve repository from git remotes. Re-run with --all to list sessions across repositories.');
  }
  const { sessions } = await listReviewSessions(workerUrl, {
    limit: options?.limit,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
  });
  printSessionList(sessions, options);
}

export async function showLatestReviewSessionCommand(options?: { all?: boolean }): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const { repo, branch } = resolveSessionScope({ all: options?.all });
  if (!options?.all && !repo) {
    throw new Error('Unable to resolve repository from git remotes. Re-run with --all to list sessions across repositories.');
  }
  const { sessions } = await listReviewSessions(workerUrl, {
    limit: 1,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
  });

  if (sessions.length === 0) {
    throw new Error(
      options?.all
        ? 'No review sessions found.'
        : 'No review sessions found for the current repo/branch.'
    );
  }

  printSessionDetails(sessions[0]);
}

export async function resetReviewSessionCommand(sessionId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const { session } = await getReviewSession(workerUrl, sessionId);
  if (session.activeReviewId && isActiveReviewStatus(session.currentReviewStatus)) {
    throw new Error(
      `Review session ${session.id} still has an active pass (${session.currentReviewStatus}). Wait for it to finish before resetting.`
    );
  }

  const response = await resetWorkspace(workerUrl, session.workspaceId);
  p.log.success(`Reset workspace ${response.workspace.id} for review session ${session.id}`);
  console.log('');
  console.log(`  Baseline Ready:  ${response.workspace.baselineReady ? 'yes' : 'no'}`);
  console.log(`  Workspace ID:    ${response.workspace.id}`);
  console.log(`  Updated At:      ${response.workspace.updatedAt}`);
  if (response.warning) {
    p.log.warning(response.warning);
  }
}

export async function listLocalReviewSessionsCommand(options?: { all?: boolean }): Promise<void> {
  await listLocalReviewEnvironmentsCommand({ all: options?.all });
}

export async function diffLocalReviewSessionCommand(
  sessionId?: string,
  options?: { baseRef?: string }
): Promise<void> {
  await diffLocalReviewEnvironmentCommand(sessionId, { baseRef: options?.baseRef });
}

export async function pathLocalReviewSessionCommand(sessionId?: string): Promise<void> {
  await printLocalReviewEnvironmentPathCommand(sessionId);
}

export async function enterLocalReviewSessionCommand(sessionId?: string): Promise<void> {
  await printEnterLocalReviewEnvironmentCommand(sessionId);
}

export { materializeReviewSessionCommand } from '../../app/reviews/materialize.js';
export { setReviewSessionMaterializeFlowForTests } from '../../app/reviews/materialize.js';
export { setLocalReviewEnvironmentFlowForTests };
