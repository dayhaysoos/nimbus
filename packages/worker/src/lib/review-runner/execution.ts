import type { Env, ReviewContext, ReviewReport, ReviewRunResponse } from '../../types.js';
import { appendReviewEvent } from '../db.js';
import { buildWorkspaceDeploymentReport } from './deployment-report.js';
import type { ReviewRunExecutionOptions } from './shared.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_started',
    payload: {
      targetType: review.target.type,
      mode: review.mode,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_completed',
    payload: {
      ok: true,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_analysis_started',
    payload: {
      deploymentId: review.deploymentId,
      workspaceId: review.workspaceId,
    },
  });

  const target = asRecord(payload.target);
  const targetType = typeof target.type === 'string' ? target.type : review.target.type;
  if (targetType !== 'workspace_deployment') {
    throw new Error(`Unsupported review target type: ${targetType}`);
  }

  const report = await buildWorkspaceDeploymentReport(env, review, payload, reviewContext, options);
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
  }

  return report;
}
