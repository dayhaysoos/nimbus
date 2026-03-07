import { strict as assert } from 'assert';
import { handleGetJobEvents } from './job-events.js';

function createDbMock(hasJob: boolean, eventRows: Array<Record<string, unknown>> = []): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (/SELECT \* FROM jobs/i.test(sql)) {
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
              }

              return null;
            },
            async all<T>() {
              if (/FROM\s+job_events/i.test(sql)) {
                assert.equal(values[0], 'job_abc12345');

                return {
                  results: eventRows as T[],
                };
              }

              if (!hasJob) {
                return {
                  results: [] as T[],
                };
              }

              return {
                results: [] as T[],
              };
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
    const response = await handleGetJobEvents('job_missing', new Request('https://example.com/api/jobs/job_missing/events'), env);
    assert.equal(response.status, 404);
  }

  {
    const env = { DB: createDbMock(true) } as never;
    const response = await handleGetJobEvents(
      'job_abc12345',
      new Request('https://example.com/api/jobs/job_abc12345/events'),
      env
    );
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

  {
    const env = {
      DB: createDbMock(true, [
        {
          id: 1,
          job_id: 'job_abc12345',
          attempt_no: 0,
          seq: 2,
          event_type: 'phase_changed',
          phase: 'building',
          payload_json: '{"status":"running"}',
          created_at: '2026-03-06T10:00:00.000Z',
        },
      ]),
    } as never;

    const response = await handleGetJobEvents(
      'job_abc12345',
      new Request('https://example.com/api/jobs/job_abc12345/events?from=1'),
      env
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /id: 2/);
    assert.match(text, /^data:\s+/m);
    assert.match(text, /"type":"phase_changed"/);
    assert.match(text, /"seq":2/);
    assert.match(text, /"status":"running"/);
    assert.match(text, /"type":"snapshot"/);
    assert.match(text, /"status":"queued"/);
  }
}
