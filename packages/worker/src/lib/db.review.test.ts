import { strict as assert } from 'assert';
import {
  ReviewIdempotencyConflictError,
  appendReviewEvent,
  claimReviewRunForExecution,
  createReviewRun,
  getReviewRun,
  listReviewEvents,
} from './db.js';

export async function runReviewDbTests(): Promise<void> {
  {
    const db = {
      prepare(sql: string) {
        if (/SELECT review_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE workspace_id = \?\s+AND idempotency_key = \?\s+AND julianday\(created_at\) >= julianday\(\?\)/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_runs/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    deployment_id: values[2],
                    target_type: values[3],
                    mode: values[4],
                    status: 'queued',
                    idempotency_key: values[5],
                    request_payload_json: values[6],
                    request_payload_sha256: values[7],
                    provenance_json: values[8],
                    last_event_seq: 0,
                    attempt_count: 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_run_idempotency/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind(reviewId: string) {
              return {
                async first<T>() {
                  return {
                    id: reviewId,
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    last_event_seq: 1,
                    attempt_count: 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { last_event_seq: 2 } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT seq, event_type, payload_json, created_at\s+FROM review_events/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: [
                      {
                        seq: 1,
                        event_type: 'review_created',
                        payload_json: '{"ok":true}',
                        created_at: '2026-03-11T00:00:00.000Z',
                      },
                    ],
                  } as unknown as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const created = await createReviewRun(db, {
      id: 'rev_abcd1234',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      targetType: 'workspace_deployment',
      mode: 'report_only',
      idempotencyKey: 'idem-review',
      requestPayload: {},
      requestPayloadSha256: 'hash',
    });
    assert.equal(created.reused, false);
    assert.equal(created.review.id, 'rev_abcd1234');

    const review = await getReviewRun(db, 'rev_abcd1234');
    assert.ok(review);

    const seq = await appendReviewEvent(db, {
      reviewId: 'rev_abcd1234',
      eventType: 'review_created',
      payload: { ok: true },
    });
    assert.equal(seq, 2);

    const events = await listReviewEvents(db, 'rev_abcd1234');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'review_created');
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT review_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    review_id: 'rev_existing',
                    request_payload_sha256: 'different-hash',
                    expires_at: '2999-01-01T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await assert.rejects(
      createReviewRun(db, {
        id: 'rev_abcd1234',
        workspaceId: 'ws_abc12345',
        deploymentId: 'dep_abcd1234',
        targetType: 'workspace_deployment',
        mode: 'report_only',
        idempotencyKey: 'idem-review',
        requestPayload: {},
        requestPayloadSha256: 'hash',
      }),
      (error: unknown) => error instanceof ReviewIdempotencyConflictError
    );
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT review_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE workspace_id = \?\s+AND idempotency_key = \?\s+AND julianday\(created_at\) >= julianday\(\?\)/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'rev_existing',
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    last_event_seq: 0,
                    attempt_count: 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_run_idempotency/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const reused = await createReviewRun(db, {
      id: 'rev_new',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      targetType: 'workspace_deployment',
      mode: 'report_only',
      idempotencyKey: 'idem-review',
      requestPayload: {},
      requestPayloadSha256: 'hash',
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.review.id, 'rev_existing');
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'rev_hiddenprov',
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'succeeded',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: JSON.stringify({ promptSummary: 'create-time prompt summary' }),
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-03-11T00:00:00.000Z',
                    finished_at: '2026-03-11T00:01:00.000Z',
                    report_json: JSON.stringify({
                      summary: {
                        riskLevel: 'low',
                        findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                        recommendation: 'approve',
                      },
                      findings: [],
                      intent: { goal: null, constraints: [], decisions: [] },
                      evidence: [],
                      provenance: { sessionIds: [], promptSummary: null, transcriptUrl: null },
                      markdownSummary: null,
                    }),
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:01:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const review = await getReviewRun(db, 'rev_hiddenprov');
    assert.ok(review);
    assert.equal(review?.provenance.promptSummary, null);
  }

  {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const claimed = await claimReviewRunForExecution(db, 'rev_retrying');
    assert.equal(claimed, true);
    assert.equal(statements.some((sql) => /error_code = NULL/i.test(sql)), true);
    assert.equal(statements.some((sql) => /error_message = NULL/i.test(sql)), true);
  }
}
