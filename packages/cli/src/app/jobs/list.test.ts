import { strict as assert } from 'assert';
import { formatListedJobs, formatRelativeTime, loadListedJobsView, setListJobsApiForTests } from './list.js';

export async function runJobListAppTests(): Promise<void> {
  try {
    {
      const now = new Date('2026-03-30T12:00:00.000Z');
      const lines = formatListedJobs(
        [
          {
            id: 'job_abc12345',
            prompt: 'Generate a deployment.',
            model: 'anthropic/claude-3.7-sonnet',
            status: 'completed',
            createdAt: '2026-03-30T11:58:00.000Z',
            deployedUrl: 'https://example.dev',
          },
        ],
        now
      );

      assert.equal(lines[1]?.includes('ID'), true);
      assert.equal(lines[3]?.includes('[+] completed'), true);
      assert.equal(lines[3]?.includes('2m ago'), true);
      assert.equal(lines[3]?.includes('https://example.dev'), true);
    }

    {
      const now = new Date('2026-03-30T12:00:00.000Z');
      assert.equal(formatRelativeTime('2026-03-30T11:59:45.000Z', now), 'just now');
      assert.equal(formatRelativeTime('2026-03-30T11:00:00.000Z', now), '1h ago');
      assert.equal(formatRelativeTime('2026-03-25T12:00:00.000Z', now), '5d ago');
    }

    {
      setListJobsApiForTests(async () => ({ jobs: [] }));
      const view = await loadListedJobsView('https://worker.example.com');
      assert.equal(view.jobs.length, 0);
      assert.equal(view.emptyMessage?.includes('No jobs found'), true);
      assert.equal(view.totalLine, null);
    }
  } finally {
    setListJobsApiForTests(null);
  }
}
