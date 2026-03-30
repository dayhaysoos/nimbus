import { strict as assert } from 'assert';
import {
  calculateDuration,
  describeWatchedJobStatus,
  formatCancelledJobLines,
  formatCompletedJobLines,
  formatFailedJobLines,
  formatWatchTimeoutLines,
  watchJobUntilTerminal,
} from './watch.js';
import type { JobResponse } from '../../lib/types.js';

function createJobResponse(status: JobResponse['status']): JobResponse {
  return {
    id: 'job_abc12345',
    prompt: 'Build a deployment preview for the feature branch.',
    model: 'anthropic/claude-3.7-sonnet',
    status,
    phase: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'queued',
    createdAt: '2026-03-30T12:00:00.000Z',
    startedAt: '2026-03-30T12:00:05.000Z',
    completedAt: status === 'completed' ? '2026-03-30T12:01:10.000Z' : null,
    previewUrl: 'https://preview.example.com',
    deployedUrl: status === 'completed' ? 'https://live.example.com' : null,
    errorMessage: status === 'failed' ? 'Build step failed' : null,
    fileCount: 12,
  };
}

export async function runJobWatchAppTests(): Promise<void> {
  {
    const seenStatuses: string[] = [];
    const jobs: JobResponse[] = [
      createJobResponse('queued'),
      { ...createJobResponse('running'), status: 'running', phase: 'building' },
      createJobResponse('completed'),
    ];
    let index = 0;
    const outcome = await watchJobUntilTerminal('https://worker.example.com', 'job_abc12345', {
      pollIntervalMs: 1,
      maxPollCount: 3,
      getJob: async () => jobs[index++] ?? jobs[jobs.length - 1],
      sleep: async () => {},
      onStatusChange: (job) => {
        seenStatuses.push(job.status);
      },
    });

    assert.deepEqual(seenStatuses, ['queued', 'running', 'completed']);
    assert.equal(outcome.kind, 'completed');
  }

  {
    const outcome = await watchJobUntilTerminal('https://worker.example.com', 'job_timeout', {
      pollIntervalMs: 1,
      maxPollCount: 2,
      getJob: async () => createJobResponse('running'),
      sleep: async () => {},
    });

    assert.deepEqual(outcome, {
      kind: 'timeout',
      jobId: 'job_timeout',
      lastStatus: 'running',
      pollIntervalMs: 1,
      maxPollCount: 2,
    });
  }

  {
    assert.equal(describeWatchedJobStatus(createJobResponse('queued')), 'Job is queued...');
    assert.equal(describeWatchedJobStatus(createJobResponse('running')), 'Job is running...');
    assert.equal(describeWatchedJobStatus(createJobResponse('completed')), null);
  }

  {
    const completedLines = formatCompletedJobLines(createJobResponse('completed'));
    assert.equal(completedLines.some((line) => line.includes('Duration: 1m 5s')), true);

    const failedLines = formatFailedJobLines(createJobResponse('failed'));
    assert.equal(failedLines.some((line) => line.includes('Prompt:   Build a deployment preview for the feature branch.')), true);

    const cancelledLines = formatCancelledJobLines(createJobResponse('cancelled'));
    assert.equal(cancelledLines.some((line) => line.includes('Prompt:   Build a deployment preview for the feature branch.')), true);
  }

  {
    const timeoutLines = formatWatchTimeoutLines({
      kind: 'timeout',
      jobId: 'job_timeout',
      lastStatus: 'running',
      pollIntervalMs: 2000,
      maxPollCount: 150,
    });
    assert.equal(timeoutLines[0], 'Job job_timeout is still running after 5 minutes.');
    assert.equal(timeoutLines[2], '  nimbus watch job_timeout');
    assert.equal(calculateDuration('2026-03-30T12:00:00.000Z', '2026-03-30T14:05:00.000Z'), '2h 5m');
  }
}
