import * as p from '@clack/prompts';
import { getWorkerUrl, getJob } from '../lib/api.js';
import { getShortModelName } from '../lib/models.js';
import type { JobResponse, JobStatus } from '../lib/types.js';

const POLL_INTERVAL = 2000; // 2 seconds
const MAX_POLL_COUNT = 150; // 5 minutes max (150 * 2s)

/**
 * Watch command - poll job status until completion
 */
export async function watchCommand(jobId: string): Promise<void> {
  const workerUrl = getWorkerUrl();

  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    process.exit(1);
  }

  const spinner = p.spinner();
  let lastStatus: JobStatus | undefined;
  let pollCount = 0;

  try {
    spinner.start(`Watching job ${jobId}...`);

    while (pollCount < MAX_POLL_COUNT) {
      const job = await getJob(workerUrl, jobId);
      pollCount++;

      // Update spinner based on status
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        updateSpinner(spinner, job);
      }

      // Check for terminal states
      if (job.status === 'completed') {
        spinner.stop('Job completed');
        displayJobResult(job);
        process.exit(0);
      }

      if (job.status === 'failed') {
        spinner.stop('Job failed');
        displayJobError(job);
        process.exit(1);
      }

      // Wait before polling again
      await sleep(POLL_INTERVAL);
    }

    // Timeout reached
    spinner.stop('Timeout');
    p.log.warning(`Job ${jobId} is still ${lastStatus || 'pending'} after 5 minutes.`);
    p.log.info('The job may still be running. Check again later with:');
    p.log.info(`  nimbus watch ${jobId}`);
    process.exit(1);
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

/**
 * Update spinner message based on job status
 */
function updateSpinner(spinner: ReturnType<typeof p.spinner>, job: JobResponse): void {
  switch (job.status) {
    case 'pending':
      spinner.message('Job is pending...');
      break;
    case 'running':
      spinner.message('Job is running...');
      break;
  }
}

/**
 * Display completed job result
 */
function displayJobResult(job: JobResponse): void {
  console.log('');
  p.log.success('Build completed successfully!');
  console.log('');

  if (job.previewUrl) {
    p.log.info(`Preview URL: ${job.previewUrl}`);
  }

  if (job.deployedUrl) {
    p.outro(`Deployed: ${job.deployedUrl}`);
  }

  // Show summary
  console.log('');
  console.log('  Job Details:');
  console.log(`    ID:       ${job.id}`);
  console.log(`    Model:    ${getShortModelName(job.model)}`);
  console.log(`    Files:    ${job.fileCount || 'N/A'}`);

  if (job.startedAt && job.completedAt) {
    const duration = calculateDuration(job.startedAt, job.completedAt);
    console.log(`    Duration: ${duration}`);
  }

  console.log('');
}

/**
 * Display failed job error
 */
function displayJobError(job: JobResponse): void {
  console.log('');
  p.log.error('Build failed');
  console.log('');

  if (job.errorMessage) {
    p.log.error(job.errorMessage);
  }

  // If preview URL exists, build succeeded but deployment failed
  if (job.previewUrl) {
    console.log('');
    p.log.info('Build succeeded but deployment failed.');
    p.log.info(`Preview URL (temporary): ${job.previewUrl}`);
  }

  console.log('');
  console.log('  Job Details:');
  console.log(`    ID:       ${job.id}`);
  console.log(`    Model:    ${getShortModelName(job.model)}`);
  console.log(`    Prompt:   ${job.prompt.slice(0, 50)}${job.prompt.length > 50 ? '...' : ''}`);
  console.log('');
}

/**
 * Calculate duration between two ISO dates
 */
function calculateDuration(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  } else if (diffMinutes < 60) {
    const remainingSeconds = diffSeconds % 60;
    return `${diffMinutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(diffMinutes / 60);
    const remainingMinutes = diffMinutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
