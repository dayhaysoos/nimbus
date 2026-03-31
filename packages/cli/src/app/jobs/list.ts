import { listJobs } from '../../clients/worker/jobs.js';
import { getShortModelName } from '../../lib/models.js';
import type { JobListItem, JobStatus } from '../../lib/types.js';

export interface ListedJobsView {
  jobs: JobListItem[];
  lines: string[];
  totalLine: string | null;
  emptyMessage: string | null;
}

let listJobsForView = listJobs;

export function setListJobsApiForTests(handler: typeof listJobs | null): void {
  listJobsForView = handler ?? listJobs;
}

export async function loadListedJobsView(workerUrl: string, now: Date = new Date()): Promise<ListedJobsView> {
  const response = await listJobsForView(workerUrl);
  if (response.jobs.length === 0) {
    return {
      jobs: response.jobs,
      lines: [],
      totalLine: null,
      emptyMessage: 'No jobs found. Create one with: nimbus deploy checkpoint <checkpoint-id-or-commit-ish> --no-dry-run',
    };
  }

  return {
    jobs: response.jobs,
    lines: formatListedJobs(response.jobs, now),
    totalLine: `${response.jobs.length} job(s) total`,
    emptyMessage: null,
  };
}

export function formatListedJobs(jobs: JobListItem[], now: Date = new Date()): string[] {
  return ['', formatHeader(), formatSeparator(), ...jobs.map((job) => formatJob(job, now)), ''];
}

function formatHeader(): string {
  const id = 'ID'.padEnd(14);
  const status = 'Status'.padEnd(12);
  const model = 'Model'.padEnd(18);
  const created = 'Created'.padEnd(14);
  const url = 'URL';

  return `  ${id} ${status} ${model} ${created} ${url}`;
}

function formatSeparator(): string {
  return '  ' + '-'.repeat(80);
}

function formatJob(job: JobListItem, now: Date): string {
  const id = job.id.padEnd(14);
  const status = formatStatus(job.status).padEnd(12);
  const model = getShortModelName(job.model).slice(0, 16).padEnd(18);
  const created = formatRelativeTime(job.createdAt, now).padEnd(14);
  const url = job.deployedUrl || '-';

  return `  ${id} ${status} ${model} ${created} ${url}`;
}

function formatStatus(status: JobStatus): string {
  const indicators: Record<JobStatus, string> = {
    queued: '[ ] queued',
    running: '[~] running',
    completed: '[+] completed',
    failed: '[x] failed',
    cancelled: '[-] cancelled',
  };
  return indicators[status] || status;
}

export function formatRelativeTime(isoDate: string, now: Date = new Date()): string {
  const date = new Date(isoDate);
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString();
}
