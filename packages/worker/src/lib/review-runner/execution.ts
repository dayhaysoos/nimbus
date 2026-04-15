import type { Env, ReviewContext, ReviewReport, ReviewRunResponse } from '../../types.js';
import { appendReviewEvent, getReviewRun } from '../db.js';
import { buildWorkspaceDeploymentReport } from './deployment-report.js';
import type { ReviewRunExecutionOptions } from './shared.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function throwIfReviewExecutionAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error('Review execution aborted by external signal');
  error.name = 'AbortError';
  throw error;
}

async function throwIfReviewManuallyAborted(env: Env, reviewId: string): Promise<void> {
  const latest = await getReviewRun(env.DB, reviewId);
  if (latest?.status === 'failed' && latest.error?.code === 'review_execution_aborted') {
    const error = new Error('Review execution aborted by external signal');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * Runs review preflight + analysis for a single already-claimed review and emits the per-finding lifecycle events.
 */
export async function executeReviewRun(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  reviewContext: ReviewContext,
  options?: ReviewRunExecutionOptions
): Promise<ReviewReport> {
  throwIfReviewExecutionAborted(options?.abortSignal);
  await throwIfReviewManuallyAborted(env, review.id);
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_started',
    payload: {
      targetType: review.target.type,
      mode: review.mode,
    },
  });
  throwIfReviewExecutionAborted(options?.abortSignal);
  await throwIfReviewManuallyAborted(env, review.id);
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_completed',
    payload: {
      ok: true,
    },
  });
  throwIfReviewExecutionAborted(options?.abortSignal);
  await throwIfReviewManuallyAborted(env, review.id);
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_analysis_started',
    payload: {
      deploymentId: review.deploymentId,
      workspaceId: review.workspaceId,
    },
  });
  throwIfReviewExecutionAborted(options?.abortSignal);
  await throwIfReviewManuallyAborted(env, review.id);

  const target = asRecord(payload.target);
  const targetType = typeof target.type === 'string' ? target.type : review.target.type;
  if (targetType !== 'workspace_deployment') {
    throw new Error(`Unsupported review target type: ${targetType}`);
  }

  const report = await buildWorkspaceDeploymentReport(env, review, payload, reviewContext, options);
  throwIfReviewExecutionAborted(options?.abortSignal);
  await throwIfReviewManuallyAborted(env, review.id);
  for (const finding of report.findings) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_finding_emitted',
      payload: {
        severity: finding.severity,
        category: finding.category,
        passType: finding.passType,
        description: finding.description,
      },
    });
    throwIfReviewExecutionAborted(options?.abortSignal);
    await throwIfReviewManuallyAborted(env, review.id);
  }

  return report;
}
