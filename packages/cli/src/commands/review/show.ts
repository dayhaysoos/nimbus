import * as p from '@clack/prompts';
import { getReview, getWorkerUrl } from '../../lib/api.js';

export async function showReviewCommand(reviewId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const { review } = await getReview(workerUrl, reviewId);

  p.log.info(`Review ${review.id}`);
  console.log('');
  console.log(`  Status:          ${review.status}`);
  console.log(`  Workspace ID:    ${review.workspaceId}`);
  console.log(`  Deployment ID:   ${review.deploymentId}`);
  console.log(`  Target:          ${review.target.type}`);
  console.log(`  Mode:            ${review.mode}`);
  console.log(`  Recommendation:  ${review.summary?.recommendation ?? 'pending'}`);
  console.log(`  Risk Level:      ${review.summary?.riskLevel ?? 'pending'}`);
  console.log(`  Findings:        ${review.findings.length}`);
  console.log(`  Created At:      ${review.createdAt}`);
  console.log(`  Updated At:      ${review.updatedAt}`);
  if (review.error) {
    console.log(`  Error:           ${review.error.code}: ${review.error.message}`);
  }

  if (review.intent?.goal) {
    console.log('');
    console.log(`  Intent:          ${review.intent.goal}`);
  }
  if (review.provenance.promptSummary) {
    console.log(`  Provenance:      ${review.provenance.promptSummary}`);
  }
  if (review.markdownSummary) {
    console.log('');
    console.log(review.markdownSummary);
  }
}
