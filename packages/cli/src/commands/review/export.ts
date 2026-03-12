import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import * as p from '@clack/prompts';
import { getReview, getWorkerUrl } from '../../lib/api.js';

export async function exportReviewCommand(
  reviewId: string,
  format: 'markdown' | 'json',
  outputPath: string
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }
  if (!outputPath.trim()) {
    throw new Error('Output path is required');
  }

  const { review } = await getReview(workerUrl, reviewId);
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  const contents =
    format === 'markdown'
      ? review.markdownSummary ?? '## Review Summary\n\nNo markdown summary is available for this review.\n'
      : JSON.stringify(review, null, 2) + '\n';

  await writeFile(absolutePath, contents, 'utf8');
  p.log.success(`Exported ${format} review to ${absolutePath}`);
}
