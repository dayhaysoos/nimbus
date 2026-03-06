import { strict as assert } from 'assert';
import { handleGetJobEvents } from './job-events.js';

function createDbMock(hasJob: boolean): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              if (!hasJob) {
                return null;
              }

              return {
                id: 'job_abc12345',
                prompt: 'Deploy checkpoint 8a513f56ed70',
                model: 'checkpoint',
                status: 'queued',
                phase: 'queued',
                created_at: '2026-03-06T10:00:00.000Z',
                started_at: null,
                completed_at: null,
                preview_url: null,
                deployed_url: null,
                error_message: null,
                file_count: null,
              } as T;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

export async function runJobEventsApiTests(): Promise<void> {
  {
    const env = { DB: createDbMock(false) } as never;
    const response = await handleGetJobEvents('job_missing', env);
    assert.equal(response.status, 404);
  }

  {
    const env = { DB: createDbMock(true) } as never;
    const response = await handleGetJobEvents('job_abc12345', env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');

    const text = await response.text();
    assert.match(text, /data: /);

    const payloadRaw = text.replace(/^data:\s*/, '').trim();
    const payload = JSON.parse(payloadRaw) as {
      type: string;
      jobId: string;
      status: string;
      phase: string;
    };

    assert.equal(payload.type, 'snapshot');
    assert.equal(payload.jobId, 'job_abc12345');
    assert.equal(payload.status, 'queued');
    assert.equal(payload.phase, 'queued');
  }
}
