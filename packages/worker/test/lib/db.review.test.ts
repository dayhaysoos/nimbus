import { strict as assert } from 'assert';
import {
  ReviewIdempotencyConflictError,
  attachReviewPassToSession,
  appendReviewEvent,
  claimReviewRunForExecution,
  createReviewSession,
  createReviewRun,
  getReviewCochangeCacheBatch,
  getReviewRun,
  getReviewSession,
  listReviewEvents,
  upsertReviewCochangeCacheBatch,
} from '../../src/lib/db.js';

export async function runReviewDbTests(): Promise<void> {
  {
    let insertValues: unknown[] = [];
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
              insertValues = values;
              return {
                async first<T>() {
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    deployment_id: values[2],
                    session_id: values[3],
                    target_type: values[4],
                    mode: values[5],
                    status: values[6],
                    idempotency_key: values[7],
                    request_payload_json: values[8],
                    request_payload_sha256: values[9],
                    account_id: values[10],
                    provenance_json: values[11],
                    repo: values[12],
                    branch: values[13],
                    derived_policy_json: values[14],
                    approved_policy_json: values[15],
                    approved_policy_sha256: values[16],
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
                    session_id: 'session_abc12345',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
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
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      accountId: 'acct_workspace_owner',
    });
    assert.equal(created.reused, false);
    assert.equal(created.review.id, 'rev_abcd1234');
    assert.equal(insertValues[10], 'acct_workspace_owner');

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
    const state = {
      sessionId: 'session_abcd1234',
      activeReviewId: null as string | null,
      latestReviewId: null as string | null,
      passCount: 0,
    };
    const db = {
      prepare(sql: string) {
        if (/INSERT INTO review_sessions/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.sessionId = String(values[0]);
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    anchor_deployment_id: values[2],
                    repo: values[3],
                    branch: values[4],
                    initial_review_basis: values[5],
                    anchor_commit_sha: values[6],
                    anchor_checkpoint_id: values[7],
                    source_project_root: values[8],
                    active_review_id: null,
                    latest_review_id: null,
                    pass_count: 0,
                    stop_reason: null,
                    account_id: values[9],
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/UPDATE review_sessions\s+SET active_review_id = \?/i.test(sql)) {
          return {
            bind(activeReviewId: string, latestReviewId: string) {
              return {
                async run() {
                  state.activeReviewId = activeReviewId;
                  state.latestReviewId = latestReviewId;
                  state.passCount = 1;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT \* FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async first<T>() {
                  if (sessionId !== state.sessionId) {
                    return null as T;
                  }
                  return {
                    id: state.sessionId,
                    workspace_id: 'ws_abc12345',
                    anchor_deployment_id: 'dep_abcd1234',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'a'.repeat(40),
                    anchor_checkpoint_id: null,
                    source_project_root: '.',
                    active_review_id: state.activeReviewId,
                    latest_review_id: state.latestReviewId,
                    pass_count: state.passCount,
                    stop_reason: null,
                    account_id: 'acct_123',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async all<T>() {
                  if (sessionId !== state.sessionId || !state.latestReviewId) {
                    return { results: [] } as unknown as T;
                  }
                  return {
                    results: [
                      {
                        id: state.latestReviewId,
                        session_id: state.sessionId,
                        status: 'running',
                        request_payload_json: JSON.stringify({ reviewBasis: 'checkpoint' }),
                        created_at: '2026-03-11T00:00:00.000Z',
                        started_at: '2026-03-11T00:00:01.000Z',
                        finished_at: null,
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
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const session = await createReviewSession(db, {
      id: 'session_abcd1234',
      workspaceId: 'ws_abc12345',
      anchorDeploymentId: 'dep_abcd1234',
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      initialReviewBasis: 'checkpoint',
      anchorCommitSha: 'a'.repeat(40),
      sourceProjectRoot: '.',
      accountId: 'acct_123',
    });
    assert.equal(session.id, 'session_abcd1234');
    assert.equal(session.phase, 'preparing');
    assert.equal(session.passCount, 0);

    await attachReviewPassToSession(db, session.id, 'rev_abcd1234');
    const hydrated = await getReviewSession(db, session.id);
    assert.ok(hydrated);
    assert.equal(hydrated?.passCount, 1);
    assert.equal(hydrated?.phase, 'reviewing');
    assert.equal(hydrated?.latestReviewId, 'rev_abcd1234');
    assert.equal(hydrated?.stopReason, null);
    assert.equal(hydrated?.finishedAt, null);
    assert.equal(hydrated?.passes[0]?.reviewBasis, 'checkpoint');
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT \* FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async first<T>() {
                  if (sessionId !== 'session_active_failed') {
                    return null as T;
                  }
                  return {
                    id: 'session_active_failed',
                    workspace_id: 'ws_active_failed',
                    anchor_deployment_id: 'dep_active_failed',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'a'.repeat(40),
                    anchor_checkpoint_id: null,
                    source_project_root: '.',
                    active_review_id: 'rev_failed_active',
                    latest_review_id: 'rev_failed_active',
                    pass_count: 1,
                    stop_reason: null,
                    account_id: 'acct_123',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:02:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async all<T>() {
                  if (sessionId !== 'session_active_failed') {
                    return { results: [] } as unknown as T;
                  }
                  return {
                    results: [
                      {
                        id: 'rev_failed_active',
                        session_id: 'session_active_failed',
                        status: 'failed',
                        request_payload_json: JSON.stringify({ reviewBasis: 'checkpoint' }),
                        created_at: '2026-03-11T00:00:00.000Z',
                        started_at: '2026-03-11T00:00:05.000Z',
                        finished_at: '2026-03-11T00:01:00.000Z',
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
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const session = await getReviewSession(db, 'session_active_failed');
    assert.ok(session);
    assert.equal(session?.phase, 'failed');
    assert.equal(session?.stopReason, 'initial_pass_failed');
    assert.equal(session?.finishedAt, '2026-03-11T00:01:00.000Z');
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT \* FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async first<T>() {
                  if (sessionId !== 'session_envtrace') {
                    return null as T;
                  }
                  return {
                    id: 'session_envtrace',
                    workspace_id: 'ws_envtrace',
                    anchor_deployment_id: 'dep_envtrace',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'b'.repeat(40),
                    anchor_checkpoint_id: '8a513f56ed70',
                    source_project_root: '.',
                    active_review_id: 'review_envtrace',
                    latest_review_id: 'review_envtrace',
                    pass_count: 2,
                    stop_reason: 'followup_pass_completed',
                    account_id: 'acct_123',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:04:00.000Z',
                    finished_at: '2026-03-11T00:04:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async all<T>() {
                  if (sessionId !== 'session_envtrace') {
                    return { results: [] } as unknown as T;
                  }
                  return {
                    results: [
                      {
                        id: 'review_checkpoint',
                        workspace_id: 'ws_envtrace',
                        deployment_id: 'dep_envtrace',
                        session_id: 'session_envtrace',
                        target_type: 'workspace_deployment',
                        mode: 'report_only',
                        status: 'succeeded',
                        idempotency_key: 'idem-review-checkpoint',
                        request_payload_json: JSON.stringify({ reviewBasis: 'checkpoint' }),
                        request_payload_sha256: 'hash-checkpoint',
                        provenance_json: JSON.stringify({ promptSummary: 'Initial checkpoint review.' }),
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                        derived_policy_json: null,
                        approved_policy_json: null,
                        approved_policy_sha256: null,
                        last_event_seq: 1,
                        attempt_count: 1,
                        created_at: '2026-03-11T00:00:00.000Z',
                        started_at: '2026-03-11T00:00:01.000Z',
                        finished_at: '2026-03-11T00:01:00.000Z',
                        report_json: JSON.stringify({
                          summary: {
                            riskLevel: 'medium',
                            findingCounts: { critical: 0, high: 0, medium: 1, low: 0 },
                            recommendation: 'comment',
                          },
                          findings: [
                            {
                              severity: 'medium',
                              category: 'logic',
                              passType: 'single',
                              locations: [{ filePath: 'src/math.ts', startLine: 1, endLine: 1 }],
                              description: 'add() subtracts instead of adds.',
                              suggestedFix: 'Return a + b.',
                            },
                          ],
                          evidence: [
                            {
                              id: 'ev_test_passed',
                              type: 'test',
                              label: 'Unit tests passed',
                              status: 'failed',
                            },
                          ],
                          provenance: {
                            reviewContextMode: 'intent_aware',
                            sessionIds: ['sess_checkpoint'],
                            policyItems: [],
                            promptSummary: 'Initial checkpoint review.',
                          },
                        }),
                        markdown_summary: null,
                        error_code: null,
                        error_message: null,
                        updated_at: '2026-03-11T00:01:00.000Z',
                      },
                      {
                        id: 'review_envtrace',
                        workspace_id: 'ws_envtrace',
                        deployment_id: 'dep_envtrace',
                        session_id: 'session_envtrace',
                        target_type: 'workspace_deployment',
                        mode: 'report_only',
                        status: 'succeeded',
                        idempotency_key: 'idem-review-envtrace',
                        request_payload_json: JSON.stringify({
                          reviewBasis: 'environment',
                          provenance: {
                            trigger: 'session_auto_remediation',
                            remediationTaskSummary: 'Updated add() to return the sum.',
                            reviewContextMode: 'basic',
                            environmentRevision: {
                              source: 'workspace_head',
                              diffSha256: 'c'.repeat(64),
                              changedFileCount: 3,
                              generatedAt: '2026-03-11T00:03:00.000Z',
                            },
                          },
                        }),
                        request_payload_sha256: 'hash-envtrace',
                        provenance_json: JSON.stringify({ promptSummary: 'Follow-up environment review.' }),
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                        derived_policy_json: null,
                        approved_policy_json: null,
                        approved_policy_sha256: null,
                        last_event_seq: 2,
                        attempt_count: 1,
                        created_at: '2026-03-11T00:03:00.000Z',
                        started_at: '2026-03-11T00:03:02.000Z',
                        finished_at: '2026-03-11T00:04:00.000Z',
                        report_json: JSON.stringify({
                          summary: {
                            riskLevel: 'low',
                            findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                            recommendation: 'approve',
                          },
                          summaryText: 'Nimbus completed review and no actionable findings remain.',
                          findings: [],
                          evidence: [
                            {
                              id: 'ev_test_passed',
                              type: 'test',
                              label: 'Unit tests passed',
                              status: 'passed',
                            },
                          ],
                          provenance: {
                            reviewContextMode: 'basic',
                            sessionIds: [],
                            policyItems: [],
                            promptSummary: 'Follow-up environment review.',
                            validation: {
                              followUpReviewScore: 1,
                              followUpReviewRationale: 'No additional meaningful issues remain.',
                            },
                          },
                        }),
                        markdown_summary: null,
                        error_code: null,
                        error_message: null,
                        updated_at: '2026-03-11T00:04:00.000Z',
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
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const session = await getReviewSession(db, 'session_envtrace');
    assert.ok(session);
    assert.equal(session?.passes[1]?.reviewBasis, 'environment');
    assert.equal(session?.passes[1]?.environmentRevision?.diffSha256, 'c'.repeat(64));
    assert.equal(session?.passes[1]?.environmentRevision?.changedFileCount, 3);
    assert.equal(session?.outcome?.kind, 'clean');
    assert.equal(session?.outcome?.reviewed.contextMode, 'basic');
    assert.equal(session?.outcome?.changes.applied, true);
    assert.equal(session?.outcome?.changes.remediationCount, 1);
    assert.equal(session?.outcome?.changes.changedFileCount, 3);
    assert.equal(session?.outcome?.materializeReady, true);
    assert.equal(session?.outcome?.unresolved.findingCount, 0);
    assert.equal(session?.outcome?.evidence.passed, 1);
    assert.equal(session?.outcome?.evidence.failed, 0);
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT \* FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async first<T>() {
                  if (sessionId !== 'session_policy_wait') {
                    return null as T;
                  }
                  return {
                    id: 'session_policy_wait',
                    workspace_id: 'ws_policy_wait',
                    anchor_deployment_id: 'dep_policy_wait',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'd'.repeat(40),
                    anchor_checkpoint_id: null,
                    source_project_root: '.',
                    active_review_id: 'review_policy_wait',
                    latest_review_id: 'review_policy_wait',
                    pass_count: 1,
                    stop_reason: null,
                    account_id: 'acct_123',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:01:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async all<T>() {
                  if (sessionId !== 'session_policy_wait') {
                    return { results: [] } as unknown as T;
                  }
                  return {
                    results: [
                      {
                        id: 'review_policy_wait',
                        session_id: 'session_policy_wait',
                        status: 'policy_pending',
                        request_payload_json: JSON.stringify({ reviewBasis: 'checkpoint' }),
                        created_at: '2026-03-11T00:00:00.000Z',
                        started_at: null,
                        finished_at: null,
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
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const session = await getReviewSession(db, 'session_policy_wait');
    assert.ok(session);
    assert.equal(session?.phase, 'waiting_on_human');
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
        repo: 'dayhaysoos/nimbus',
        branch: 'main',
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
                    session_id: 'session_existing',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
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
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
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
                    session_id: 'session_hiddenprov',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'succeeded',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: JSON.stringify({ promptSummary: 'create-time prompt summary' }),
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
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
                      provenance: {
                        sessionIds: [],
                        promptSummary: null,
                        transcriptUrl: null,
                        reviewContextRef: { id: 'ctx_abc123', r2Key: 'review-context/rev_hiddenprov/ctx_abc123.json' },
                        reviewContextStats: {
                          totalFilesIncluded: 7,
                          totalBytesIncluded: 12800,
                          estimatedTokens: 3200,
                          tokenBudget: 10000,
                        },
                        reviewedFiles: {
                          changed: ['src/report.tsx'],
                          related: ['src/context.ts'],
                          conventions: ['package.json'],
                        },
                      },
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
    assert.equal(review?.provenance.reviewContextRef?.id, 'ctx_abc123');
    assert.equal(review?.provenance.reviewContextStats?.estimatedTokens, 3200);
    assert.deepEqual(review?.provenance.reviewedFiles, {
      changed: ['src/report.tsx'],
      related: ['src/context.ts'],
      conventions: ['package.json'],
    });
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
                    id: 'rev_phase2_contract',
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    session_id: 'session_phase2_contract',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'succeeded',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-03-11T00:00:00.000Z',
                    finished_at: '2026-03-11T00:01:00.000Z',
                    report_json: JSON.stringify({
                      summary: {
                        riskLevel: 'low',
                        findingCounts: { info: 0, critical: 0, high: 0, medium: 0, low: 0 },
                        recommendation: 'approve',
                      },
                      findings: [
                        {
                          severity: 'high',
                          confidence: 'medium',
                          title: 'Legacy finding shape',
                          description: 'legacy payload',
                          conditions: null,
                          locations: [{ path: 'src/legacy.ts', line: 12 }],
                          suggestedFix: null,
                          evidenceRefs: [],
                        },
                        {
                          severity: 'medium',
                          category: 'logic',
                          passType: 'single',
                          locations: [{ filePath: 'src/new.ts', startLine: 3, endLine: 4 }],
                          description: 'Valid v2 finding',
                          suggestedFix: '',
                        },
                      ],
                      summaryText: 'Model summary text',
                      furtherPassesLowYield: true,
                      intent: { goal: null, constraints: [], decisions: [] },
                      evidence: [],
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                        sessionIds: [],
                        policyItems: [],
                        promptSummary: null,
                        transcriptUrl: null,
                      },
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

    const review = await getReviewRun(db, 'rev_phase2_contract');
    assert.ok(review);
    // Intentional Phase 2 behavior: strict V2 surfaces exclude legacy finding shapes.
    assert.equal(review?.findings.length, 1);
    assert.equal(review?.findings[0]?.description, 'Valid v2 finding');
    assert.equal(review?.summaryText, 'Model summary text');
    assert.equal(review?.furtherPassesLowYield, true);
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

  {
    const allCalls: Array<Array<unknown>> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async all<T>() {
                allCalls.push([sql, ...values]);
                return { results: [] } as unknown as T;
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await getReviewCochangeCacheBatch(db, {
      repo: 'dayhaysoos/nimbus',
      filePaths: Array.from({ length: 45 }, (_value, index) => `src/file-${index}.ts`),
    });

    assert.equal(allCalls.length, 3);
    const bindCounts = allCalls.map((call) => call.length - 1);
    assert.deepEqual(bindCounts, [21, 21, 6]);
  }

  {
    const runCalls: Array<Array<unknown>> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                runCalls.push([sql, ...values]);
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await upsertReviewCochangeCacheBatch(
      db,
      Array.from({ length: 41 }, (_value, index) => ({
        filePath: `src/file-${index}.ts`,
        repo: 'dayhaysoos/nimbus',
        branch: 'entire/checkpoints/v1',
        cochange: [],
        lookbackSessions: 5,
      }))
    );

    assert.equal(runCalls.length, 3);
    const bindCounts = runCalls.map((call) => call.length - 1);
    assert.deepEqual(bindCounts, [120, 120, 6]);
  }
}
