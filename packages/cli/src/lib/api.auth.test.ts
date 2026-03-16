import { strict as assert } from 'assert';
import { __resetApiClientStateForTests, getJob } from './api.js';

const HOSTED_URL = 'https://nimbus-worker.ndejesus1227.workers.dev';

export async function runApiAuthTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.NIMBUS_API_KEY;
  const originalStderrWrite = process.stderr.write;

  try {
    {
      __resetApiClientStateForTests();
      delete process.env.NIMBUS_API_KEY;

      const stderrMessages: string[] = [];
      let fetchCount = 0;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
        fetchCount += 1;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('X-Nimbus-Api-Key'), null);
        return new Response(
          JSON.stringify({
            id: 'job_abc12345',
            prompt: 'test',
            model: 'claude',
            status: 'queued',
            phase: 'queued',
            createdAt: '2026-03-15T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            previewUrl: null,
            deployedUrl: null,
            errorMessage: null,
            fileCount: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      process.stderr.write = ((chunk: unknown) => {
        stderrMessages.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      await getJob(HOSTED_URL, 'job_abc12345');
      await getJob(HOSTED_URL, 'job_abc12345');

      assert.equal(fetchCount, 2);
      const warningCount = stderrMessages.filter((message) => message.includes('NIMBUS_API_KEY is required')).length;
      assert.equal(warningCount, 1);
    }

    {
      __resetApiClientStateForTests();
      delete process.env.NIMBUS_API_KEY;

      const stderrMessages: string[] = [];
      globalThis.fetch = (async (_input: unknown, _init?: RequestInit): Promise<Response> => {
        return new Response(
          JSON.stringify({
            id: 'job_abc12345',
            prompt: 'test',
            model: 'claude',
            status: 'queued',
            phase: 'queued',
            createdAt: '2026-03-15T00:00:00.000Z',
            startedAt: null,
            completedAt: null,
            previewUrl: null,
            deployedUrl: null,
            errorMessage: null,
            fileCount: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      process.stderr.write = ((chunk: unknown) => {
        stderrMessages.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      await getJob('https://worker.example.com', 'job_abc12345');
      assert.equal(stderrMessages.filter((message) => message.includes('NIMBUS_API_KEY is required')).length, 0);
    }
  } finally {
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    if (originalApiKey === undefined) {
      delete process.env.NIMBUS_API_KEY;
    } else {
      process.env.NIMBUS_API_KEY = originalApiKey;
    }
    globalThis.fetch = originalFetch;
  }
}
