import type {
  Env,
  ReviewContext,
  ReviewEnvironmentRevision,
  ReviewReport,
  ReviewRunResponse,
  ReviewSessionStopReason,
} from '../../types.js';
import {
  appendReviewEvent,
  finalizeReviewSession,
  getReviewRun,
  getReviewSession,
  getWorkspace,
  getWorkspaceTask,
  getWorkspaceTaskRequestPayload,
} from '../db.js';
import { dispatchReviewToRunner } from '../review-dispatch.js';
import { createReviewQueueMessage } from '../review-queue.js';
import { createReviewSessionPass } from '../review-session-pass.js';
import { readOptionalNumber, readOptionalString } from './context-helpers.js';
import { captureWorkspaceEnvironmentSnapshot } from './environment.js';

interface ReviewSessionRemediationTaskPayload {
  type: 'review_session';
  sessionId: string;
  sourceReviewId: string;
  preTaskEnvironmentRevision: ReviewEnvironmentRevision;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toReviewReport(review: ReviewRunResponse): ReviewReport | null {
  if (!review.summary || !review.intent) {
    return null;
  }

  return {
    summary: review.summary,
    findings: review.findings,
    summaryText: review.summaryText,
    furtherPassesLowYield: review.furtherPassesLowYield,
    intent: review.intent,
    evidence: review.evidence,
    provenance: review.provenance,
    markdownSummary: review.markdownSummary,
  };
}

function readRemediationTaskPayload(value: Record<string, unknown> | null): ReviewSessionRemediationTaskPayload | null {
  const remediation = asRecord(value?.reviewSessionRemediation);
  if (remediation.type !== 'review_session') {
    return null;
  }
  if (typeof remediation.sessionId !== 'string' || !remediation.sessionId.trim()) {
    return null;
  }
  if (typeof remediation.sourceReviewId !== 'string' || !remediation.sourceReviewId.trim()) {
    return null;
  }
  const preTaskEnvironmentRevision = remediation.preTaskEnvironmentRevision;
  if (!preTaskEnvironmentRevision || typeof preTaskEnvironmentRevision !== 'object' || Array.isArray(preTaskEnvironmentRevision)) {
    return null;
  }
  const revision = preTaskEnvironmentRevision as Record<string, unknown>;
  if (
    revision.source !== 'workspace_head' ||
    typeof revision.diffSha256 !== 'string' ||
    !revision.diffSha256.trim() ||
    typeof revision.changedFileCount !== 'number' ||
    !Number.isFinite(revision.changedFileCount) ||
    typeof revision.generatedAt !== 'string' ||
    !revision.generatedAt.trim()
  ) {
    return null;
  }

  return {
    type: 'review_session',
    sessionId: remediation.sessionId.trim(),
    sourceReviewId: remediation.sourceReviewId.trim(),
    preTaskEnvironmentRevision: {
      source: 'workspace_head',
      diffSha256: revision.diffSha256.trim(),
      changedFileCount: Math.max(0, Math.floor(revision.changedFileCount)),
      generatedAt: revision.generatedAt.trim(),
    },
  };
}

async function appendReviewEventBestEffort(
  env: Env,
  input: { reviewId: string; eventType: string; payload: Record<string, unknown> }
): Promise<void> {
  try {
    await appendReviewEvent(env.DB, input);
  } catch {
    // Best-effort telemetry only.
  }
}

async function deriveFollowupLocalCochange(
  env: Env,
  review: ReviewRunResponse,
  report: ReviewReport
): Promise<
  | {
      source: 'local_git';
      checkpointsRef: string;
      lookbackSessions: number;
      topN: number;
      sessionsScanned: number;
      relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
    }
  | null
> {
  const reviewContextRef = report.provenance.reviewContextRef ?? review.provenance.reviewContextRef;
  if (!reviewContextRef?.r2Key) {
    return null;
  }
  const storageBucketCandidates = [env.REVIEW_CONTEXTS, env.WORKSPACE_ARTIFACTS, env.SOURCE_BUNDLES];
  const readableBuckets = storageBucketCandidates.filter(
    (bucket): bucket is R2Bucket => Boolean(bucket && typeof bucket.get === 'function')
  );
  if (readableBuckets.length === 0) {
    return null;
  }

  let object: R2ObjectBody | null = null;
  for (const bucket of readableBuckets) {
    try {
      const candidate = await bucket.get(reviewContextRef.r2Key);
      if (candidate) {
        object = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!object) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    return null;
  }

  const context = asRecord(parsed) as Partial<ReviewContext> & Record<string, unknown>;
  const checkpoint = asRecord(context.checkpoint);
  const retrieval = asRecord(context.retrieval);
  const coChange = asRecord(retrieval.coChange);
  if (readOptionalString(coChange.source) !== 'local_git') {
    return null;
  }

  const checkpointsRef = readOptionalString(checkpoint.branch) ?? 'entire/checkpoints/v1';
  const lookbackSessions = Math.max(1, Math.floor(readOptionalNumber(coChange.lookbackSessions) ?? 5));
  const topN = Math.max(1, Math.floor(readOptionalNumber(coChange.topN) ?? 20));
  const sessionsScanned = Math.max(0, Math.floor(readOptionalNumber(coChange.sessionsScanned) ?? 0));
  const relatedByChangedPathRaw = asRecord(retrieval.relatedByChangedPath);
  const relatedByChangedPath = Object.fromEntries(
    Object.entries(relatedByChangedPathRaw).flatMap(([path, entries]) => {
      if (!Array.isArray(entries)) {
        return [];
      }
      const normalized = entries
        .map((entry) => asRecord(entry))
        .filter((entry) => typeof entry.path === 'string' && typeof entry.frequency === 'number')
        .map((entry) => ({
          path: String(entry.path),
          frequency: Math.max(0, Math.floor(Number(entry.frequency))),
          sessionIds: Array.isArray(entry.sessionIds)
            ? entry.sessionIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            : [],
        }));
      return normalized.length > 0 ? [[path, normalized]] : [];
    })
  );

  if (Object.keys(relatedByChangedPath).length === 0) {
    return null;
  }

  return {
    source: 'local_git',
    checkpointsRef,
    lookbackSessions,
    topN,
    sessionsScanned,
    relatedByChangedPath,
  };
}

function isActiveSessionStatus(status: ReviewRunResponse['status'] | null): boolean {
  return status === 'policy_pending' || status === 'policy_ready' || status === 'policy_approved' || status === 'queued' || status === 'running';
}

async function finalizeIfCurrent(
  env: Env,
  sessionId: string,
  sourceReviewId: string,
  stopReason: ReviewSessionStopReason
): Promise<boolean> {
  return finalizeReviewSession(env.DB, sessionId, {
    latestReviewId: sourceReviewId,
    stopReason,
    expectedLatestReviewId: sourceReviewId,
  });
}

async function enqueueFollowupReviewPass(
  env: Env,
  input: { reviewId: string; reused: boolean }
): Promise<void> {
  if (env.REVIEWS_QUEUE) {
    await env.REVIEWS_QUEUE.send(createReviewQueueMessage(input.reviewId));
    await appendReviewEventBestEffort(env, {
      reviewId: input.reviewId,
      eventType: 'review_enqueued',
      payload: {
        mode: 'queue',
        reused: input.reused,
        trigger: 'session_auto_remediation',
      },
    });
    return;
  }

  if (env.ReviewRunner) {
    await dispatchReviewToRunner(env, createReviewQueueMessage(input.reviewId));
    await appendReviewEventBestEffort(env, {
      reviewId: input.reviewId,
      eventType: 'review_enqueued',
      payload: {
        mode: 'direct',
        reused: input.reused,
        trigger: 'session_auto_remediation',
      },
    });
    return;
  }

  throw new Error('Review runner is unavailable for remediation follow-up');
}

export function buildReviewSessionRemediationTaskPayload(input: {
  prompt: string;
  provider: string;
  model: string;
  maxSteps: number;
  maxRetries: number;
  sessionId: string;
  sourceReviewId: string;
  preTaskEnvironmentRevision: ReviewEnvironmentRevision;
}): Record<string, unknown> {
  return {
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    maxSteps: input.maxSteps,
    maxRetries: input.maxRetries,
    reviewSessionRemediation: {
      type: 'review_session',
      sessionId: input.sessionId,
      sourceReviewId: input.sourceReviewId,
      preTaskEnvironmentRevision: input.preTaskEnvironmentRevision,
    },
  };
}

export async function continueReviewSessionAfterRemediationTask(
  env: Env,
  input: { workspaceId: string; taskId: string; sourceReview?: ReviewRunResponse; sourceReport?: ReviewReport }
): Promise<{ nextReviewId: string | null }> {
  const task = await getWorkspaceTask(env.DB, input.workspaceId, input.taskId);
  if (!task || task.status === 'queued' || task.status === 'running') {
    return { nextReviewId: null };
  }

  const payload = await getWorkspaceTaskRequestPayload(env.DB, input.taskId);
  const remediation = readRemediationTaskPayload(payload);
  if (!remediation) {
    return { nextReviewId: null };
  }

  const review = input.sourceReview ?? (await getReviewRun(env.DB, remediation.sourceReviewId));
  const report = input.sourceReport ?? (review ? toReviewReport(review) : null);
  if (!review || !report || review.sessionId !== remediation.sessionId) {
    return { nextReviewId: null };
  }

  const session = await getReviewSession(env.DB, remediation.sessionId);
  if (!session) {
    return { nextReviewId: null };
  }
  if (session.latestReviewId && session.latestReviewId !== remediation.sourceReviewId) {
    const advancedReviewId =
      session.activeReviewId && session.activeReviewId !== remediation.sourceReviewId
        ? session.activeReviewId
        : session.latestReviewId;
    if (advancedReviewId && session.activeReviewId === advancedReviewId && session.currentReviewStatus === 'queued') {
      await enqueueFollowupReviewPass(env, {
        reviewId: advancedReviewId,
        reused: true,
      });
    }
    await appendReviewEventBestEffort(env, {
      reviewId: remediation.sourceReviewId,
      eventType: 'review_auto_remediation_skipped',
      payload: {
        reason: 'session_state_advanced',
        taskId: task.id,
        latestReviewId: session.latestReviewId,
        activeReviewId: session.activeReviewId ?? null,
      },
    });
    return {
      nextReviewId: advancedReviewId,
    };
  }
  if (!session.activeReviewId && session.stopReason) {
    return { nextReviewId: null };
  }
  if (
    session.activeReviewId &&
    session.activeReviewId !== remediation.sourceReviewId &&
    isActiveSessionStatus(session.currentReviewStatus)
  ) {
    await appendReviewEventBestEffort(env, {
      reviewId: remediation.sourceReviewId,
      eventType: 'review_auto_remediation_skipped',
      payload: {
        reason: 'session_state_advanced',
        taskId: task.id,
        latestReviewId: session.latestReviewId ?? null,
        activeReviewId: session.activeReviewId,
      },
    });
    return { nextReviewId: null };
  }

  if (task.status !== 'succeeded') {
    await finalizeIfCurrent(env, remediation.sessionId, remediation.sourceReviewId, 'auto_remediation_failed');
    await appendReviewEventBestEffort(env, {
      reviewId: remediation.sourceReviewId,
      eventType: 'review_auto_remediation_failed',
      payload: {
        taskId: task.id,
        status: task.status,
        error: task.error ?? null,
      },
    });
    return { nextReviewId: null };
  }

  const workspace = await getWorkspace(env.DB, input.workspaceId);
  if (!workspace || workspace.status !== 'ready') {
    await finalizeIfCurrent(env, remediation.sessionId, remediation.sourceReviewId, 'auto_remediation_failed');
    await appendReviewEventBestEffort(env, {
      reviewId: remediation.sourceReviewId,
      eventType: 'review_auto_remediation_failed',
      payload: {
        taskId: task.id,
        status: task.status,
        error: { code: 'workspace_not_ready', message: 'Workspace is not ready for remediation follow-up' },
      },
    });
    return { nextReviewId: null };
  }

  const workspaceSnapshot = await captureWorkspaceEnvironmentSnapshot(env, {
    id: session.workspaceId,
    status: workspace.status,
    sandboxId: workspace.sandboxId,
    baselineReady: workspace.baselineReady,
    sourceBundleKey: workspace.sourceBundleKey,
    sourceBundleSha256: workspace.sourceBundleSha256,
  });
  if (workspaceSnapshot.revision.diffSha256 === remediation.preTaskEnvironmentRevision.diffSha256) {
    await finalizeIfCurrent(env, remediation.sessionId, remediation.sourceReviewId, 'no_progress');
    await appendReviewEventBestEffort(env, {
      reviewId: remediation.sourceReviewId,
      eventType: 'review_auto_remediation_skipped',
      payload: {
        reason: 'no_progress',
        taskId: task.id,
        preTaskDiffSha256: remediation.preTaskEnvironmentRevision.diffSha256,
        postTaskDiffSha256: workspaceSnapshot.revision.diffSha256,
      },
    });
    return { nextReviewId: null };
  }

  let followupLocalCochange: Awaited<ReturnType<typeof deriveFollowupLocalCochange>> = null;
  try {
    followupLocalCochange = await deriveFollowupLocalCochange(env, review, report);
  } catch {
    followupLocalCochange = null;
  }

  const followupPass = await createReviewSessionPass(env, {
    session,
    reviewBasis: 'environment',
    environmentSnapshot: workspaceSnapshot,
    provenance: {
      trigger: 'session_auto_remediation',
      remediationSourceReviewId: remediation.sourceReviewId,
      remediationTaskId: task.id,
      ...(followupLocalCochange ? { localCochange: followupLocalCochange } : {}),
      remediationTaskSummary:
        task.result &&
        typeof task.result === 'object' &&
        !Array.isArray(task.result) &&
        typeof (task.result as { summary?: unknown }).summary === 'string'
          ? (task.result as { summary: string }).summary
          : null,
    },
    idempotencyKey: `review-session-remediation-pass:${session.id}:${remediation.sourceReviewId}`,
  });

  await enqueueFollowupReviewPass(env, {
    reviewId: followupPass.review.id,
    reused: followupPass.reused,
  });

  await appendReviewEventBestEffort(env, {
    reviewId: remediation.sourceReviewId,
    eventType: 'review_auto_remediation_completed',
    payload: {
      taskId: task.id,
      nextReviewId: followupPass.review.id,
      environmentRevision: followupPass.environmentSnapshot?.revision ?? null,
    },
  });

  return {
    nextReviewId: followupPass.review.id,
  };
}
