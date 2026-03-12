import { strict as assert } from 'assert';
import { processReviewRun, shouldRetryReviewError } from './review-runner.js';

function createReviewRunnerEnv(options?: {
  payload?: Record<string, unknown>;
  deploymentEvents?: Array<{ seq: number; event_type: string; payload_json: string; created_at: string }>;
  failReviewFindingsInsertOnce?: boolean;
  failReviewEventTypeOnce?: string;
}): {
  env: Record<string, unknown>;
  state: {
    status: string;
    attemptCount: number;
    events: Array<{ eventType: string; payload: unknown }>;
    reportJson: string | null;
    markdownSummary: string | null;
    findingInsertFailuresRemaining: number;
    errorCode: string | null;
    failedEventTypes: Set<string>;
  };
} {
  const state = {
    status: 'queued',
    attemptCount: 0,
    events: [] as Array<{ eventType: string; payload: unknown }>,
    reportJson: null as string | null,
    markdownSummary: null as string | null,
    findingInsertFailuresRemaining: options?.failReviewFindingsInsertOnce ? 1 : 0,
    errorCode: null as string | null,
    failedEventTypes: new Set<string>(),
  };

  const payload = {
    target: {
      type: 'workspace_deployment',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
    },
    mode: 'report_only',
    provenance: {
      trigger: 'manual_cli',
      note: 'Initial review placeholder',
    },
    ...(options?.payload ?? {}),
  };

  const deploymentEvents = options?.deploymentEvents ?? [
    {
      seq: 1,
      event_type: 'validation_started',
      payload_json: '{"step":"test"}',
      created_at: '2026-03-11T00:00:10.000Z',
    },
    {
      seq: 2,
      event_type: 'deployment_succeeded',
      payload_json: '{"deployedUrl":"https://example.com"}',
      created_at: '2026-03-11T00:01:00.000Z',
    },
  ];

  const env = {
    DB: {
      prepare(sql: string) {
        if (/UPDATE review_runs\s+SET status = 'running'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  if (state.status !== 'queued') {
                    return { success: true, meta: { changes: 0 } };
                  }
                  state.status = 'running';
                  state.attemptCount += 1;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'rev_abcd1234',
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: state.status,
                    idempotency_key: 'idem-review-1',
                    request_payload_json: JSON.stringify(payload),
                    request_payload_sha256: 'hash',
                    provenance_json: JSON.stringify(payload.provenance),
                    last_event_seq: state.events.length,
                    attempt_count: state.attemptCount,
                    started_at: null,
                    finished_at: null,
                    report_json: state.reportJson,
                    markdown_summary: state.markdownSummary,
                    error_code: state.errorCode,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT request_payload_json FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { request_payload_json: JSON.stringify(payload) } as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_deployments WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'dep_abcd1234',
                    workspace_id: 'ws_abc12345',
                    status: 'succeeded',
                    provider: 'simulated',
                    idempotency_key: 'idem-deploy',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    max_retries: 2,
                    attempt_count: 1,
                    source_snapshot_sha256: 'sha',
                    source_bundle_key: 'bundle',
                    provenance_json: '{}',
                    provider_deployment_id: 'provider_dep',
                    deployed_url: 'https://example.com',
                    last_event_seq: 2,
                    cancel_requested_at: null,
                    started_at: '2026-03-11T00:00:00.000Z',
                    finished_at: '2026-03-11T00:01:00.000Z',
                    duration_ms: 60000,
                    result_json: JSON.stringify({
                      url: 'https://example.com',
                      artifact: {
                        sourceBundleKey: 'bundle',
                        sourceSnapshotSha256: 'sha',
                        outputBundleSha256: 'outsha',
                        outputDir: '.',
                      },
                      provenance: {
                        trigger: 'manual_cli',
                      },
                    }),
                    toolchain_json: null,
                    dependency_cache_key: null,
                    dependency_cache_hit: 0,
                    remediations_json: '[]',
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

        if (/SELECT request_payload_json FROM workspace_deployments WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    request_payload_json: JSON.stringify({
                      validation: {
                        runBuildIfPresent: true,
                        runTestsIfPresent: true,
                      },
                      provenance: {
                        trigger: 'manual_cli',
                        note: 'Review successful deployment readiness',
                      },
                    }),
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT seq, event_type, payload_json, created_at\s+FROM workspace_deployment_events/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: deploymentEvents,
                  } as unknown as T;
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
                  return { last_event_seq: state.events.length + 1 } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind(_reviewId: string, _seq: number, eventType: string, payloadJson: string) {
              return {
                async run() {
                  if (options?.failReviewEventTypeOnce === eventType && !state.failedEventTypes.has(eventType)) {
                    state.failedEventTypes.add(eventType);
                    throw new Error('database is locked');
                  }
                  state.events.push({ eventType, payload: JSON.parse(payloadJson) });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/DELETE FROM review_findings WHERE review_id = \?/i.test(sql)) {
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

        if (/INSERT INTO review_findings/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  if (state.findingInsertFailuresRemaining > 0) {
                    state.findingInsertFailuresRemaining -= 1;
                    throw new Error('database is locked');
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET/i.test(sql)) {
          return {
            bind(status: string, _updatedAt: string, ...values: unknown[]) {
              return {
                async run() {
                  state.status = status;
                  state.errorCode = values.find((value) => typeof value === 'string' && (value === 'retry_scheduled' || value === 'review_execution_failed')) as string | null;
                  const reportValue = values.find((value) => typeof value === 'string' && String(value).includes('findingCounts'));
                  if (typeof reportValue === 'string') {
                    state.reportJson = reportValue;
                  } else if (status === 'queued') {
                    state.reportJson = null;
                  }
                  const markdownValue = values.find((value) => typeof value === 'string' && String(value).includes('## Review Summary'));
                  if (typeof markdownValue === 'string') {
                    state.markdownSummary = markdownValue;
                  } else if (status === 'succeeded') {
                    state.markdownSummary = null;
                  } else if (status === 'queued') {
                    state.markdownSummary = null;
                  }
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
    },
  };

  return { env, state };
}

export async function runReviewRunnerTests(): Promise<void> {
  {
    const { env, state } = createReviewRunnerEnv();
    await processReviewRun(env as never, 'rev_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.events.some((event) => event.eventType === 'review_preflight_started'), true);
    assert.equal(state.events.some((event) => event.eventType === 'review_finalize_started'), true);
    assert.equal(state.events.some((event) => event.eventType === 'review_succeeded'), true);
    assert.equal(typeof state.reportJson, 'string');
    assert.equal(typeof state.markdownSummary, 'string');
    const report = JSON.parse(state.reportJson ?? '{}') as { evidence: Array<{ type: string; status: string }> };
    const validationStarted = report.evidence.find((item) => item.type === 'validation_started');
    assert.equal(validationStarted?.status, 'info');
  }

  {
    const { env, state } = createReviewRunnerEnv({
      payload: {
        policy: {
          severityThreshold: 'medium',
          maxFindings: 1,
          includeProvenance: false,
          includeValidationEvidence: false,
        },
        format: {
          primary: 'json',
          includeMarkdownSummary: false,
        },
      },
      deploymentEvents: [
        {
          seq: 1,
          event_type: 'deployment_validation_tool_missing',
          payload_json: '{"step":"test","message":"pnpm missing"}',
          created_at: '2026-03-11T00:00:10.000Z',
        },
        {
          seq: 2,
          event_type: 'validation_skipped',
          payload_json: '{"step":"build","reason":"tool_missing"}',
          created_at: '2026-03-11T00:00:20.000Z',
        },
      ],
    });
    await processReviewRun(env as never, 'rev_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.markdownSummary, null);
    const report = JSON.parse(state.reportJson ?? '{}') as {
      findings: unknown[];
      evidence: unknown[];
      provenance: { promptSummary: string | null; sessionIds: string[] };
      markdownSummary: string | null;
    };
    assert.equal(report.findings.length, 1);
    assert.equal(report.evidence.length, 0);
    assert.equal(report.provenance.promptSummary, null);
    assert.deepEqual(report.provenance.sessionIds, []);
    assert.equal(report.markdownSummary, null);
  }

  {
    const { env, state } = createReviewRunnerEnv({
      deploymentEvents: [
        {
          seq: 1,
          event_type: 'deployment_validation_tool_missing',
          payload_json: '{"step":"test","message":"pnpm missing"}',
          created_at: '2026-03-11T00:00:10.000Z',
        },
      ],
      failReviewFindingsInsertOnce: true,
    });
    await assert.rejects(() => processReviewRun(env as never, 'rev_abcd1234'), /retry requested/);
    assert.equal(state.status, 'queued');
    assert.equal(state.errorCode, 'retry_scheduled');
    assert.equal(state.events.some((event) => event.eventType === 'review_retry_scheduled'), true);
  }

  {
    const { env, state } = createReviewRunnerEnv({
      failReviewEventTypeOnce: 'review_succeeded',
    });
    await assert.rejects(() => processReviewRun(env as never, 'rev_abcd1234'), /retry requested/);
    assert.equal(state.status, 'queued');
    assert.equal(state.reportJson, null);
    assert.equal(state.markdownSummary, null);
  }

  {
    const retry = shouldRetryReviewError(new Error('database is locked'));
    assert.equal(retry, true);
  }
}
