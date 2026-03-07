import { strict as assert } from 'assert';
import { appendJobEvent, listJobEvents } from './db.js';

export async function runDbEventsTests(): Promise<void> {
  {
    const calls: Array<{ sql: string; values: unknown[] }> = [];

    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            calls.push({ sql, values });

            if (/UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
              return {
                async first<T>() {
                  return { last_event_seq: 7 } as T;
                },
              };
            }

            if (/INSERT INTO job_events/i.test(sql)) {
              return {
                async run() {
                  return { success: true, meta: { duration: 0 } };
                },
              };
            }

            throw new Error(`Unexpected SQL in test: ${sql}`);
          },
        };
      },
    } as unknown as D1Database;

    const seq = await appendJobEvent(db, {
      jobId: 'job_abc12345',
      eventType: 'phase_changed',
      phase: 'building',
      payload: { value: 1 },
    });

    assert.equal(seq, 7);
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /last_event_seq/);
    assert.match(calls[1].sql, /INSERT INTO job_events/);
  }

  {
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            assert.match(sql, /FROM\s+job_events/i);
            assert.equal(values[0], 'job_abc12345');
            assert.equal(values[1], 3);

            return {
              async all<T>() {
                return {
                  results: [
                    {
                      id: 1,
                      job_id: 'job_abc12345',
                      attempt_no: 0,
                      seq: 4,
                      event_type: 'phase_changed',
                      phase: 'building',
                      payload_json: '{"x":1}',
                      created_at: '2026-03-06T10:00:00.000Z',
                    },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const events = await listJobEvents(db, 'job_abc12345', 3);
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 4);
    assert.deepEqual(events[0].payload, { x: 1 });
  }
}
