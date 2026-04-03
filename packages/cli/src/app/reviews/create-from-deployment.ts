import * as p from '@clack/prompts';
import { approveReviewPolicy, createReview, deriveReviewPolicy } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { validateReviewCochangeTokenReadiness } from '../../commands/review/preflight.js';
import { startReviewStudioCommand } from './open.js';
import { buildIdempotencyKey, resolveReviewGitProvenance } from './create-shared.js';

export async function createReviewCommand(
  workspaceId: string,
  deploymentId: string,
  options?: {
    idempotencyKey?: string;
    policyMode?: 'none' | 'auto' | 'review';
    reviewBasis?: 'checkpoint' | 'environment';
    openStudio?: boolean;
    openStudioPort?: number;
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
  const policyMode = options?.policyMode ?? 'none';
  const reviewBasis = options?.reviewBasis ?? 'checkpoint';

  const gitProvenance = resolveReviewGitProvenance();

  const provenance = {
    repo: gitProvenance.repo,
    branch: gitProvenance.branch,
    ...(options?.intentSummaryModel?.trim() ? { intentSummaryModel: options.intentSummaryModel.trim() } : {}),
  };

  let reviewId = '';
  let status = '';
  let resultUrl = '';
  let eventsUrl = '';
  if (policyMode === 'none') {
    const response = await createReview(workerUrl, options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId, deploymentId), {
      target: {
        type: 'workspace_deployment',
        workspaceId,
        deploymentId,
      },
      mode: 'report_only',
      policyMode,
      reviewBasis,
      policy: {
        severityThreshold: options?.severityThreshold ?? 'low',
        maxFindings: options?.maxFindings,
        includeProvenance: options?.includeProvenance ?? true,
        includeValidationEvidence: options?.includeValidationEvidence ?? true,
      },
      model: options?.model,
      provenance,
    });
    reviewId = response.reviewId;
    status = response.status;
    resultUrl = response.resultUrl;
    eventsUrl = response.eventsUrl;
  } else {
    const derived = await deriveReviewPolicy(workerUrl, {
      workspaceId,
      deploymentId,
      policyMode,
      reviewBasis,
      provenance,
    });
    reviewId = derived.reviewId;
    if (policyMode === 'auto') {
      await approveReviewPolicy(workerUrl, reviewId, {
        approvedPolicy: derived.derivedPolicy,
      });
      status = 'policy_approved';
    } else {
      status = derived.status;
    }
    resultUrl = `${workerUrl}/api/reviews/${encodeURIComponent(reviewId)}`;
    eventsUrl = `${workerUrl}/api/reviews/${encodeURIComponent(reviewId)}/events`;
  }

  p.log.success(`Review queued: ${reviewId}`);
  p.log.message(`Policy mode: ${policyMode}`);
  p.log.message(`Review basis: ${reviewBasis}`);
  p.log.message(`Status: ${status}`);
  p.log.message(`Result URL: ${resultUrl}`);
  p.log.message(`Events URL: ${eventsUrl}`);

  if (options?.openStudio) {
    await startReviewStudioCommand({
      port: options.openStudioPort,
      routePath: policyMode === 'review' ? `/policy/${encodeURIComponent(reviewId)}` : `/reports/${encodeURIComponent(reviewId)}`,
      detach: true,
    });
  }
}
