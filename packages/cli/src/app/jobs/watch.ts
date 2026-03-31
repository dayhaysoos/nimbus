import { getJob } from '../../clients/worker/jobs.js';
import { getShortModelName } from '../../lib/models.js';
import type { JobResponse, JobStatus } from '../../lib/types.js';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_COUNT = 150;

export type WatchedJobOutcome =
  | { kind: 'completed'; job: JobResponse }
  | { kind: 'failed'; job: JobResponse }
  | { kind: 'cancelled'; job: JobResponse }
  | {
      kind: 'timeout';
      jobId: string;
      lastStatus: JobStatus | null;
      pollIntervalMs: number;
      maxPollCount: number;
    };

export interface WatchJobOptions {
  pollIntervalMs?: number;
  maxPollCount?: number;
  onStatusChange?: (job: JobResponse) => void;
  sleep?: (ms: number) => Promise<void>;
  getJob?: typeof getJob;
}

export async function watchJobUntilTerminal(
  workerUrl: string,
  jobId: string,
  options: WatchJobOptions = {}
): Promise<WatchedJobOutcome> {
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const maxPollCount = Math.max(1, options.maxPollCount ?? DEFAULT_MAX_POLL_COUNT);
  const getJobForWatch = options.getJob ?? getJob;
  const sleepForWatch = options.sleep ?? sleep;
  let lastStatus: JobStatus | null = null;

  for (let pollCount = 0; pollCount < maxPollCount; pollCount += 1) {
    const job = await getJobForWatch(workerUrl, jobId);
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      options.onStatusChange?.(job);
    }

    if (job.status === 'completed') {
      return { kind: 'completed', job };
    }
    if (job.status === 'failed') {
      return { kind: 'failed', job };
    }
    if (job.status === 'cancelled') {
      return { kind: 'cancelled', job };
    }

    await sleepForWatch(pollIntervalMs);
  }

  return {
    kind: 'timeout',
    jobId,
    lastStatus,
    pollIntervalMs,
    maxPollCount,
  };
}

export function describeWatchedJobStatus(job: JobResponse): string | null {
  switch (job.status) {
    case 'queued':
      return 'Job is queued...';
    case 'running':
      return 'Job is running...';
    case 'cancelled':
      return 'Job was cancelled.';
    default:
      return null;
  }
}

export function formatCompletedJobLines(job: JobResponse): string[] {
  const lines = ['', '  Job Details:'];
  lines.push(`    ID:       ${job.id}`);
  lines.push(`    Model:    ${getShortModelName(job.model)}`);
  lines.push(`    Files:    ${job.fileCount || 'N/A'}`);

  if (job.startedAt && job.completedAt) {
    lines.push(`    Duration: ${calculateDuration(job.startedAt, job.completedAt)}`);
  }

  lines.push('');
  return lines;
}

export function formatFailedJobLines(job: JobResponse): string[] {
  const lines = ['', '  Job Details:'];
  lines.push(`    ID:       ${job.id}`);
  lines.push(`    Model:    ${getShortModelName(job.model)}`);
  lines.push(`    Prompt:   ${truncatePrompt(job.prompt)}`);
  lines.push('');
  return lines;
}

export function formatCancelledJobLines(job: JobResponse): string[] {
  return [
    '',
    '  Job Details:',
    `    ID:       ${job.id}`,
    `    Model:    ${getShortModelName(job.model)}`,
    `    Prompt:   ${truncatePrompt(job.prompt)}`,
    '',
  ];
}

export function formatWatchTimeoutLines(outcome: Extract<WatchedJobOutcome, { kind: 'timeout' }>): string[] {
  const minutes = Math.floor((outcome.pollIntervalMs * outcome.maxPollCount) / 60000);
  return [
    `Job ${outcome.jobId} is still ${outcome.lastStatus || 'queued'} after ${minutes} minutes.`,
    'The job may still be running. Check again later with:',
    `  nimbus watch ${outcome.jobId}`,
  ];
}

export function calculateDuration(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }
  if (diffMinutes < 60) {
    const remainingSeconds = diffSeconds % 60;
    return `${diffMinutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(diffMinutes / 60);
  const remainingMinutes = diffMinutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function truncatePrompt(prompt: string): string {
  return `${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
