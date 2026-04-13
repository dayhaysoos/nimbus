import * as p from '@clack/prompts';
import { getReviewSession } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { resetWorkspace } from '../../clients/worker/workspaces.js';
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

export { materializeReviewSessionCommand } from '../../app/reviews/materialize.js';
export { setReviewSessionMaterializeFlowForTests } from '../../app/reviews/materialize.js';
