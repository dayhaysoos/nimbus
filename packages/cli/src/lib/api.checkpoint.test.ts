import { strict as assert } from 'assert';
import { createCheckpointJob } from './api.js';

export async function runCheckpointApiTests(): Promise<void> {
  const originalFetch = globalThis.fetch;

  try {
    let calledUrl = '';
    let calledMethod = '';
    let bodyIsFormData = false;

    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      calledUrl = String(input);
      calledMethod = init?.method ?? '';
      bodyIsFormData = init?.body instanceof FormData;

      return new Response(
        JSON.stringify({
          jobId: 'job_abc12345',
          status: 'queued',
          phase: 'queued',
          eventsUrl: '/api/jobs/job_abc12345/events',
          jobUrl: '/api/jobs/job_abc12345',
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }) as typeof fetch;

    const formData = new FormData();
    formData.set('metadata', '{}');
    formData.set('bundle', new File([new Uint8Array([1])], 'source.tar.gz', { type: 'application/gzip' }));

    const response = await createCheckpointJob('https://worker.example.com', formData);

    assert.equal(calledUrl, 'https://worker.example.com/api/checkpoint/jobs');
    assert.equal(calledMethod, 'POST');
    assert.equal(bodyIsFormData, true);
    assert.equal(response.jobId, 'job_abc12345');
    assert.equal(response.status, 'queued');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
