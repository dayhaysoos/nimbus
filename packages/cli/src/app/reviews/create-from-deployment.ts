import * as p from '@clack/prompts';
import { createReview } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { validateReviewCochangeTokenReadiness } from '../../commands/review/preflight.js';
import { buildIdempotencyKey, resolveReviewGitProvenance } from './create-shared.js';

export async function createReviewCommand(
  workspaceId: string,
  deploymentId: string,
  options?: {
    idempotencyKey?: string;
    severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
    maxFindings?: number;
    model?: string;
    intentSummaryModel?: string;
    includeProvenance?: boolean;
    includeValidationEvidence?: boolean;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  await validateReviewCochangeTokenReadiness();

  const gitProvenance = resolveReviewGitProvenance();

  const response = await createReview(workerUrl, options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId, deploymentId), {
    target: {
      type: 'workspace_deployment',
      workspaceId,
      deploymentId,
    },
    mode: 'report_only',
    policy: {
      severityThreshold: options?.severityThreshold ?? 'low',
      maxFindings: options?.maxFindings,
      includeProvenance: options?.includeProvenance ?? true,
      includeValidationEvidence: options?.includeValidationEvidence ?? true,
    },
    model: options?.model,
    provenance: {
      repo: gitProvenance.repo,
      branch: gitProvenance.branch,
      ...(options?.intentSummaryModel?.trim() ? { intentSummaryModel: options.intentSummaryModel.trim() } : {}),
    },
  });

  p.log.success(`Review queued: ${response.reviewId}`);
  p.log.message(`Status: ${response.status}`);
  p.log.message(`Result URL: ${response.resultUrl}`);
  p.log.message(`Events URL: ${response.eventsUrl}`);
}
