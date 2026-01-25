import * as p from '@clack/prompts';
import { getWorkerUrl, listJobs } from '../lib/api.js';
import { getShortModelName } from '../lib/models.js';
import type { JobListItem, JobStatus } from '../lib/types.js';

/**
 * List command - shows all past jobs
 */
export async function listCommand(): Promise<void> {
  const workerUrl = getWorkerUrl();

  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    process.exit(1);
  }

  const spinner = p.spinner();

  try {
    spinner.start('Fetching jobs...');

    const { jobs } = await listJobs(workerUrl);

    spinner.stop('Jobs retrieved');

    if (jobs.length === 0) {
      p.log.info('No jobs found. Create one with: nimbus start "your prompt"');
      return;
    }

    // Print table header
    console.log('');
    console.log(formatHeader());
    console.log(formatSeparator());

    // Print each job
    for (const job of jobs) {
      console.log(formatJob(job));
    }

    console.log('');
    p.log.info(`${jobs.length} job(s) total`);
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

/**
 * Format table header
 */
function formatHeader(): string {
  const id = 'ID'.padEnd(14);
  const status = 'Status'.padEnd(12);
  const model = 'Model'.padEnd(18);
  const created = 'Created'.padEnd(14);
  const url = 'URL';

  return `  ${id} ${status} ${model} ${created} ${url}`;
}

/**
 * Format separator line
 */
function formatSeparator(): string {
  return '  ' + '-'.repeat(80);
}

/**
 * Format a job row
 */
function formatJob(job: JobListItem): string {
  const id = job.id.padEnd(14);
  const status = formatStatus(job.status).padEnd(12);
  const model = getShortModelName(job.model).slice(0, 16).padEnd(18);
  const created = formatRelativeTime(job.createdAt).padEnd(14);
  const url = job.deployedUrl || '-';

  return `  ${id} ${status} ${model} ${created} ${url}`;
}

/**
 * Format job status with color indicator
 */
function formatStatus(status: JobStatus): string {
  const indicators: Record<JobStatus, string> = {
    pending: '[ ] pending',
    running: '[~] running',
    completed: '[+] completed',
    failed: '[x] failed',
    expired: '[!] expired',
  };
  return indicators[status] || status;
}

/**
 * Format ISO date as relative time
 */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}
