import { strict as assert } from 'assert';
import { processReviewRun, shouldRetryReviewError } from './review-runner.js';
import { setReviewAnalysisSandboxResolverForTests } from './review-analysis.js';

function createReviewRunnerEnv(options?: {
  payload?: Record<string, unknown>;
  deploymentEvents?: Array<{ seq: number; event_type: string; payload_json: string; created_at: string }>;
  failReviewFindingsInsertOnce?: boolean;
  failReviewEventTypeOnce?: string;
  envOverrides?: Record<string, unknown>;
  workspaceRecord?: Record<string, unknown> | null;
  workspaceTaskRecord?: Record<string, unknown> | null;
  workspaceOperationRecord?: Record<string, unknown> | null;
  workspaceArtifactLookup?: { objectKey: string; type?: string; patchText: string } | null;
  deploymentSourceBundleKey?: string | null;
  deploymentResultArtifact?: Record<string, unknown>;
  deploymentRequestProvenance?: Record<string, unknown>;
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

        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return (options?.workspaceRecord === undefined
                    ? {
                    id: 'ws_abc12345',
                    status: 'ready',
                    source_type: 'checkpoint',
                    checkpoint_id: 'chk_123',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'phase-08a',
                    source_project_root: '.',
                    source_bundle_key: options?.deploymentSourceBundleKey === undefined ? 'bundle' : options.deploymentSourceBundleKey,
                    source_bundle_sha256: 'sha',
                    source_bundle_bytes: 123,
                    sandbox_id: 'workspace-ws_abc12345',
                    baseline_ready: 1,
                    error_code: null,
                    error_message: null,
                    last_deployment_id: 'dep_abcd1234',
                    last_deployment_status: 'succeeded',
                    last_deployed_url: 'https://example.com',
                    last_deployed_at: '2026-03-11T00:01:00.000Z',
                    last_deployment_error_code: null,
                    last_deployment_error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:01:00.000Z',
                    deleted_at: null,
                  }
                    : options.workspaceRecord) as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_tasks WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return (options?.workspaceTaskRecord ?? null) as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_operations WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return (options?.workspaceOperationRecord ?? null) as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_artifacts WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (!options?.workspaceArtifactLookup) {
                    return null as T;
                  }
                  return {
                    id: 'art_patch',
                    workspace_id: 'ws_abc12345',
                    operation_id: 'op_patch',
                    type: options.workspaceArtifactLookup.type ?? 'patch',
                    status: 'available',
                    object_key: options.workspaceArtifactLookup.objectKey,
                    bytes: options.workspaceArtifactLookup.patchText.length,
                    content_type: 'text/x-diff',
                    sha256: 'sha',
                    source_baseline_sha: 'a'.repeat(40),
                    creator_id: null,
                    retention_expires_at: '2026-03-20T00:00:00.000Z',
                    expired_at: null,
                    warnings_json: '[]',
                    metadata_json: '{}',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
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
                    source_bundle_key: options?.deploymentSourceBundleKey === undefined ? 'bundle' : options.deploymentSourceBundleKey,
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
                        sourceBundleKey:
                          options?.deploymentSourceBundleKey === undefined ? 'bundle' : options.deploymentSourceBundleKey,
                        sourceSnapshotSha256: 'sha',
                        outputBundleSha256: 'outsha',
                        outputDir: '.',
                        ...(options?.deploymentResultArtifact ?? {}),
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
                        sessionIds: ['ses_review_1'],
                        intentSessionContext: ['Harden deployment validation before release.'],
                        repo: 'dayhaysoos/nimbus',
                        commitSha: 'a'.repeat(40),
                        commitDiffPatch: 'diff --git a b\n',
                        taskId: options?.workspaceTaskRecord ? 'tsk_123' : null,
                        operationId: options?.workspaceOperationRecord ? 'op_patch' : null,
                        ...(options?.deploymentRequestProvenance ?? {}),
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

        if (/INSERT INTO review_context_blobs/i.test(sql)) {
          return {
            bind(id: string, _reviewId: string, _workspaceId: string, _deploymentId: string, r2Key: string) {
              return {
                async first<T>() {
                  return { id, r2_key: r2Key } as T;
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
                  state.errorCode = values.find(
                    (value) =>
                      typeof value === 'string' &&
                      (value === 'retry_scheduled' ||
                        value === 'review_execution_failed' ||
                        value === 'unsupported_without_entire_checkpoint_context' ||
                        value === 'review_context_deployment_not_found' ||
                        value === 'review_context_storage_unavailable' ||
                        value === 'review_context_budget_exceeded' ||
                        value === 'review_context_source_bundle_missing' ||
                        value === 'review_context_diff_missing' ||
                        value === 'review_context_changed_files_missing')
                   ) as string | null;
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
    SOURCE_BUNDLES: {
      async get() {
        const encodedBundle =
          'H4sIAMDGtGkC/+3NQQ6CMBSE4a49xTuBPgXcGA7TkO4KNG0xHN+nK+IeY8L/bWYymyl5uITVjymGcy1uF2rubftJ852qzaa/96t2Nom6H1hK9dnu3TGFNc25yjBPpcrTxyVIL7fHyQEAAAAAAAAAAAAAAAAA/toLBIFmrAAoAAA=';
        const bundleBytes = Buffer.from(encodedBundle, 'base64');
        return {
          async arrayBuffer() {
            return bundleBytes.buffer.slice(
              bundleBytes.byteOffset,
              bundleBytes.byteOffset + bundleBytes.byteLength
            );
          },
          async text() {
            return '';
          },
        };
      },
      async put() {
        return;
      },
    },
    WORKSPACE_ARTIFACTS: options?.workspaceArtifactLookup
      ? {
          async get(objectKey: string) {
            if (objectKey !== options.workspaceArtifactLookup?.objectKey) {
              return null;
            }
            return {
              async text() {
                return options.workspaceArtifactLookup?.patchText ?? '';
              },
            };
          },
        }
      : undefined,
    ...(options?.envOverrides ?? {}),
  };

  return { env, state };
}

export async function runReviewRunnerTests(): Promise<void> {
  setReviewAnalysisSandboxResolverForTests(async () => ({
    async exec(command: string) {
      if (command.includes('base64 -d') || command.includes('tar -xzf') || command.includes('rm -rf')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('pathlib.Path') && command.includes('.read_text(')) {
        return { stdout: JSON.stringify({ content: 'export const value = 2;\n', bytes: 24, truncated: false }), stderr: '', exitCode: 0 };
      }
      if (command.includes('pathlib.Path') && command.includes('is_dir')) {
        return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
      }
      if (command.includes('git --no-pager diff')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {
      return undefined;
    },
    async destroy() {
      return undefined;
    },
  }) as never);
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
        provenance: {
          trigger: 'manual_cli',
        },
      },
      deploymentRequestProvenance: {
        note: null,
      },
    });
    await processReviewRun(env as never, 'rev_abcd1234');
    const report = JSON.parse(state.reportJson ?? '{}') as { provenance: { promptSummary: string | null } };
    assert.equal(report.provenance.promptSummary, 'Review generated in report_only mode for deployment dep_abcd1234.');
  }

  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    const fetchBodies: Array<Record<string, unknown>> = [];
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
        },
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
        evidence: Array<{ type: string }>;
        provenance: {
          promptSummary: string | null;
          sessionIds: string[];
          reviewContextRef?: unknown;
          reviewContextStats?: unknown;
        };
        markdownSummary: string | null;
      };
      assert.equal(report.findings.length, 1);
      assert.equal(report.evidence.every((item) => item.type === 'analysis_agent'), true);
      assert.equal(report.provenance.promptSummary, null);
      assert.deepEqual(report.provenance.sessionIds, []);
      assert.equal(report.provenance.reviewContextRef, undefined);
      assert.equal(report.provenance.reviewContextStats, undefined);
      assert.equal(report.markdownSummary, null);
      assert.equal(fetchBodies.length > 0, true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_started'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'plain text completion token=supersecret ghp_abc123 api_key=xyz',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'failed');
      const fallbackEvent = state.events.find((event) => event.eventType === 'review_analysis_output_fallback_applied');
      const serialized = JSON.stringify(fallbackEvent?.payload ?? {});
      assert.equal(serialized.includes('supersecret'), false);
      assert.equal(serialized.includes('ghp_abc123'), false);
      assert.equal(serialized.includes('api_key=xyz'), false);
      assert.equal(state.events.some((event) => event.eventType === 'review_failed'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('tar -xzf') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('.read_text(')) {
          return { stdout: JSON.stringify({ content: 'export const value = 2;\n', bytes: 24, truncated: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('is_dir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
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
    setReviewAnalysisSandboxResolverForTests(null);
  }

  {
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('tar -xzf') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('.read_text(')) {
          return { stdout: JSON.stringify({ content: 'export const value = 2;\n', bytes: 24, truncated: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('is_dir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    const { env, state } = createReviewRunnerEnv({
      failReviewEventTypeOnce: 'review_succeeded',
    });
    await assert.rejects(() => processReviewRun(env as never, 'rev_abcd1234'), /retry requested/);
    assert.equal(state.status, 'queued');
    assert.equal(state.reportJson, null);
    assert.equal(state.markdownSummary, null);
    setReviewAnalysisSandboxResolverForTests(null);
  }

  {
    const originalFetch = globalThis.fetch;
    let capturedSandboxId: string | null = null;
    setReviewAnalysisSandboxResolverForTests(async (_env, sandboxId) => {
      capturedSandboxId = sandboxId;
      return {
        async exec(command: string) {
          if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (command.includes('os.listdir')) {
            return {
              stdout: JSON.stringify({ entries: [{ name: 'package.json', type: 'file' }, { name: 'src', type: 'directory' }] }),
              stderr: '',
              exitCode: 0,
            };
          }
          if (command.includes('git diff --name-status')) {
            return {
              stdout: 'M\tpackage.json\n\n__NIMBUS_PATCH__\n@@ -1,3 +1,3 @@\n',
              stderr: '',
              exitCode: 0,
            };
          }
        if (command.includes('python3 -') && command.includes('package.json')) {
          return {
            stdout: JSON.stringify({ content: '{"name":"nimbus","token":"secret789"}', truncated: false, bytes: 38 }),
            stderr: '',
            exitCode: 0,
          };
        }
          return {
            stdout: '',
            stderr: '',
            exitCode: 0,
          };
        },
        async writeFile() {
          return undefined;
        },
        async destroy() {
          return undefined;
        },
      };
    });
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      fetchCalls.push({ url: String(input), body });
      if (fetchCalls.length === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'read_file',
              args: { path: 'package.json' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({
              findings: [
                {
                  severity: 'medium',
                  category: 'logic',
                  passType: 'single',
                  description: 'Repository metadata should stay aligned with deployment ownership to make follow-up debugging easier.',
                  locations: [{ filePath: 'package.json', startLine: 1, endLine: 1 }],
                  suggestedFix: 'Verify package.json repository metadata remains accurate for deployment handoff.',
                },
              ],
              summary: 'One logic issue identified.',
              furtherPassesLowYield: false,
            }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          AGENT_MODEL: 'claude-test',
        },
        payload: {
          provenance: {
            trigger: 'manual_cli',
            taskId: 'tsk_123',
            note: 'Review against Entire intent history for auth hardening.',
            sessionIds: ['ses_review_1'],
            intentSessionContext: ['User asked to harden auth flow and avoid token leakage in logs.'],
          },
        },
        workspaceTaskRecord: {
          id: 'tsk_123',
          workspace_id: 'ws_abc12345',
          status: 'succeeded',
          prompt: 'Review auth flow; token=secret123',
          provider: 'cloudflare_agents_sdk',
          model: 'claude-task',
          idempotency_key: 'task-idem',
          max_steps: 6,
          max_retries: 2,
          attempt_count: 1,
          started_at: '2026-03-11T00:00:00.000Z',
          finished_at: '2026-03-11T00:01:00.000Z',
          cancel_requested_at: null,
          result_json: JSON.stringify({ summary: 'Validated the deployment flow with token=secret456' }),
          error_code: null,
          error_message: null,
          created_at: '2026-03-11T00:00:00.000Z',
          updated_at: '2026-03-11T00:01:00.000Z',
        },
        deploymentRequestProvenance: {
          note: null,
          sessionIds: ['ses_deploy_1'],
          intentSessionContext: ['Deployment run validated baseline and generated source bundle.'],
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(fetchCalls.length, 2);
      assert.equal(fetchCalls[0]?.body.model, 'claude-test');
      assert.equal(capturedSandboxId, 'review-snapshot-rev_abcd1234');
      assert.equal(String(fetchCalls[0].body.prompt ?? '').includes('Intent session context excerpts'), true);
      assert.equal(
        String(fetchCalls[0].body.prompt ?? '').includes('Deployment run validated baseline and generated source bundle.'),
        true
      );
      assert.equal(
        JSON.stringify(fetchCalls[0].body).includes('secret123') || JSON.stringify(fetchCalls[0].body).includes('[REDACTED]'),
        true
      );
      assert.equal(
        JSON.stringify(fetchCalls[0].body).includes('secret456') || JSON.stringify(fetchCalls[0].body).includes('[REDACTED]'),
        true
      );
      assert.equal(
        JSON.stringify(fetchCalls[1].body).includes('secret789') || JSON.stringify(fetchCalls[1].body).includes('[REDACTED]'),
        true
      );
      const secondCallHistory = (fetchCalls[1].body.history ?? []) as Array<{ content?: string; output?: { request?: { path?: string } } }>;
      assert.equal(secondCallHistory.some((entry) => String(entry.content ?? '').includes('"path":"package.json"')), true);
      assert.equal(
        secondCallHistory.some((entry) => JSON.stringify(entry.output ?? {}).includes('"path":"package.json"')),
        true
      );
      assert.equal(secondCallHistory.some((entry) => JSON.stringify(entry.output ?? {}).includes('[REDACTED]')), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_started'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_completed'), true);
      const report = JSON.parse(state.reportJson ?? '{}') as {
        findings: Array<{ description: string; category: string; passType: string }>;
        evidence: Array<{ id: string; type: string }>;
        provenance: { promptSummary: string | null; sessionIds: string[] };
      };
      assert.equal(report.findings.some((finding) => finding.description.includes('Repository metadata')), true);
      assert.equal(report.findings.some((finding) => finding.category === 'logic'), true);
      assert.equal(report.findings.some((finding) => finding.passType === 'single'), true);
      assert.equal(report.evidence.some((item) => item.id === 'ev_review_agent' && item.type === 'analysis_agent'), true);
      assert.equal(report.provenance.promptSummary, 'Review against Entire intent history for auth hardening.');
      assert.deepEqual(report.provenance.sessionIds, ['ses_deploy_1', 'ses_review_1']);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    const fetchBodies: Array<Record<string, unknown>> = [];
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          AGENT_MODEL: 'sonnet-4.5',
        },
        payload: {
          model: 'sonnet-4.5-review-override',
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(fetchBodies[0]?.model, 'sonnet-4.5-review-override');
      const startedEvent = state.events.find((event) => event.eventType === 'review_analysis_agent_started');
      assert.equal((startedEvent?.payload as Record<string, unknown> | undefined)?.model, 'sonnet-4.5-review-override');
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    const fetchBodies: Array<Record<string, unknown>> = [];
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          REVIEW_MODEL: 'sonnet-4.5-alias',
          AGENT_MODEL: undefined,
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(fetchBodies[0]?.model, 'sonnet-4.5-alias');
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    const fetchBodies: Array<Record<string, unknown>> = [];
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          REVIEW_MODEL: '   ',
          AGENT_MODEL: 'sonnet-4.5-fallback',
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(fetchBodies[0]?.model, 'sonnet-4.5-fallback');
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    const execCommands: string[] = [];
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        execCommands.push(command);
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('with open(target_real')) {
          return { stdout: JSON.stringify({ content: 'ok', truncated: false, bytes: 2 }), stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    let callCount = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'read_file',
              args: { path: 'leak/hosts' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      const readCommand = execCommands.find((command) => command.includes('with open(target_real')) ?? '';
      assert.equal(readCommand.includes('os.path.realpath'), true);
      assert.equal(readCommand.includes('os.path.commonpath'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let bundleReads = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          WORKSPACE_ARTIFACTS: {
            async get() {
              return null;
            },
          },
          SOURCE_BUNDLES: {
            async get(key: string) {
              if (key === 'bundle') {
                bundleReads += 1;
                return {
                  async arrayBuffer() {
                    return new TextEncoder().encode('legacy bundle bytes').buffer;
                  },
                };
              }
              return null;
            },
            async put() {
              return;
            },
          },
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(bundleReads, 1);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let bundleBucketReads = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --name-status')) {
          return { stdout: '\n__NIMBUS_PATCH__\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          SOURCE_BUNDLES: undefined,
          WORKSPACE_ARTIFACTS: {
            async get(key: string) {
              if (key === 'bundle') {
                bundleBucketReads += 1;
                return {
                  async arrayBuffer() {
                    return new TextEncoder().encode('artifact bundle bytes').buffer;
                  },
                };
              }
              return null;
            },
            async put() {
              return;
            },
          },
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(bundleBucketReads, 1);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error('review agent should not be called when deployment snapshot is unavailable');
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
        },
        deploymentSourceBundleKey: null,
        deploymentResultArtifact: {
          sourceBundleKey: null,
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'failed');
      assert.equal(state.errorCode, 'review_context_source_bundle_missing');
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_started'), false);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'plain text completion that is not review json',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'failed');
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_output_fallback_applied'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_completed'), false);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'final',
              summary: 'plain text completion that is not review json',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(fetchCalls, 2);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_repair_requested'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_repair_output_received'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_completed'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    let genericCompletionFetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      genericCompletionFetchCalls += 1;
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'Completed by Cloudflare agent endpoint',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          REVIEW_AGENT_MAX_STEPS: '6',
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'failed');
      assert.equal(genericCompletionFetchCalls, 2);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_output_fallback_applied'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_completed'), false);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const { env, state } = createReviewRunnerEnv({
      workspaceRecord: null,
    });
    await processReviewRun(env as never, 'rev_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(state.errorCode, 'unsupported_without_entire_checkpoint_context');
    assert.equal(state.events.some((event) => event.eventType === 'review_context_assembly_failed'), true);
  }

  {
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('tar -xzf') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('.read_text(')) {
          return { stdout: JSON.stringify({ content: 'export const value = 2;\n', bytes: 24, truncated: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('is_dir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    const { env, state } = createReviewRunnerEnv({
      deploymentRequestProvenance: {
        commitDiffPatch:
          'diff --git a/src/feature.ts b/src/feature.ts\nindex 1111111..2222222 100644\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-a\n+b\n',
      },
    });
    await processReviewRun(env as never, 'rev_abcd1234');
    assert.equal(state.status, 'succeeded');
    const skipped = state.events.find((event) => event.eventType === 'review_context_cochange_skipped');
    assert.equal(Boolean(skipped), true);
    assert.equal((skipped?.payload as { reason?: string } | undefined)?.reason, 'missing_github_token');
    assert.equal(state.events.some((event) => event.eventType === 'review_context_assembly_succeeded'), true);
    setReviewAnalysisSandboxResolverForTests(null);
  }

  {
    const originalFetch = globalThis.fetch;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('tar -xzf') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('.read_text(')) {
          return { stdout: JSON.stringify({ content: 'export const value = 2;\n', bytes: 24, truncated: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('pathlib.Path') && command.includes('is_dir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response('forbidden', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          REVIEW_CONTEXT_GITHUB_TOKEN: 'ghp_test_token',
        },
        deploymentRequestProvenance: {
          commitDiffPatch:
            'diff --git a/src/feature.ts b/src/feature.ts\nindex 1111111..2222222 100644\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-a\n+b\n',
        },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      const skipped = state.events.find((event) => event.eventType === 'review_context_cochange_skipped');
      assert.equal(Boolean(skipped), true);
      assert.equal((skipped?.payload as { reason?: string } | undefined)?.reason, 'rate_limited');
      assert.equal(state.events.some((event) => event.eventType === 'review_context_assembly_succeeded'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let secondCallBody: Record<string, unknown> | null = null;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (!Array.isArray(body.history) || body.history.length === 0) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'run_command',
              args: { command: 'git status' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      secondCallBody = body;
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      const serialized = JSON.stringify(secondCallBody ?? {});
      assert.equal(serialized.includes('git status'), true);
      assert.equal(serialized.includes('run_command is disabled in review mode'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let secondCallBody: Record<string, unknown> | null = null;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ error: 'not_directory' }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (secondCallBody === null && Array.isArray(body.history) && body.history.length > 0) {
        secondCallBody = body;
      }
      if (secondCallBody === null) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'list_files',
              args: { path: 'package.json' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({ envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' } });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(JSON.stringify(secondCallBody ?? {}).includes('not_directory'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let secondCallBody: Record<string, unknown> | null = null;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('with open(target_real')) {
          return { stdout: JSON.stringify({ error: 'not_file' }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (secondCallBody === null && Array.isArray(body.history) && body.history.length > 0) {
        secondCallBody = body;
      }
      if (secondCallBody === null) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'read_file',
              args: { path: 'src' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({ envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' } });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(JSON.stringify(secondCallBody ?? {}).includes('not_file'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let firstPrompt = '';
    let secondCallBody: Record<string, unknown> | null = null;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --name-status')) {
          return { stdout: '\n__NIMBUS_PATCH__\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      if (!firstPrompt) {
        firstPrompt = body.prompt ?? '';
      } else if (Array.isArray((body as { history?: unknown[] }).history) && ((body as { history?: unknown[] }).history?.length ?? 0) > 0) {
        secondCallBody = body as unknown as Record<string, unknown>;
      }
      if (!secondCallBody) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'diff_summary',
              args: { maxBytes: 40 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({
              findings: [],
              summary: 'No actionable findings.',
              furtherPassesLowYield: true,
            }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          SOURCE_BUNDLES: undefined,
          WORKSPACE_ARTIFACTS: {
            async get(key: string) {
              if (key === 'bundle') {
                return {
                  async arrayBuffer() {
                    return new TextEncoder().encode('artifact bundle bytes').buffer;
                  },
                };
              }
              if (key === 'workspaces/ws_abc12345/artifacts/art_patch.patch') {
                return {
                  async text() {
                    return 'diff --git a/src/app.ts b/src/app.ts\n+const deployed = true;\n';
                  },
                };
              }
              return null;
            },
            async put() {
              return;
            },
          },
        },
        deploymentResultArtifact: {
          reviewDiffArtifactId: 'art_patch',
        },
        workspaceArtifactLookup: {
          objectKey: 'workspaces/ws_abc12345/artifacts/art_patch.patch',
          patchText: `diff --git a/src/app.ts b/src/app.ts\n+${'const deployed = true;\n'.repeat(4000)}`,
        },
        deploymentEvents: [],
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(firstPrompt.includes('Authoritative deployed diff snapshot'), true);
      assert.equal(firstPrompt.includes('const deployed = true'), true);
      assert.equal(firstPrompt.length < 50000, true);
      assert.equal(JSON.stringify(secondCallBody ?? {}).length < 5000, true);
      assert.equal(JSON.stringify(secondCallBody ?? {}).includes('const deployed = true'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --name-status')) {
          return { stdout: '\n__NIMBUS_PATCH__\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({
              findings: [
                {
                  severity: 'medium',
                  category: 'logic',
                  passType: 'single',
                  description: 'Should disappear when threshold is high.',
                  locations: [{ filePath: 'src/placeholder.ts', startLine: null, endLine: null }],
                  suggestedFix: 'Add a stricter guard.',
                },
              ],
              summary: 'One medium issue found.',
              furtherPassesLowYield: false,
            }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
        },
        payload: {
          policy: {
            severityThreshold: 'high',
          },
        },
        deploymentEvents: [],
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      const report = JSON.parse(state.reportJson ?? '{}') as {
        findings: unknown[];
        summary: { riskLevel: string; recommendation: string };
      };
      assert.equal(report.findings.length, 0);
      assert.equal(report.summary.riskLevel, 'low');
      assert.equal(report.summary.recommendation, 'approve');
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const retry = shouldRetryReviewError(new Error('database is locked'));
    assert.equal(retry, true);
  }

  {
    const originalFetch = globalThis.fetch;
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'plain text completion that is not review json',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: { AGENT_SDK_URL: 'https://agent.example.com' },
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'failed');
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_output_fallback_applied'), true);
      assert.equal(state.events.some((event) => event.eventType === 'review_analysis_agent_completed'), false);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let firstPrompt = '';
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('os.listdir')) {
          return { stdout: JSON.stringify({ entries: [] }), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    }) as never);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      if (!firstPrompt) {
        firstPrompt = body.prompt ?? '';
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: JSON.stringify({ findings: [], summary: 'No actionable findings.', furtherPassesLowYield: true }),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;
    try {
      const { env, state } = createReviewRunnerEnv({
        envOverrides: {
          AGENT_SDK_URL: 'https://agent.example.com',
          WORKSPACE_ARTIFACTS: {
            async get() {
              return null;
            },
          },
          SOURCE_BUNDLES: {
            async get(key: string) {
              if (key === 'bundle') {
                return {
                  async arrayBuffer() {
                    return new TextEncoder().encode('bundle bytes').buffer;
                  },
                };
              }
              if (key === 'workspaces/ws_abc12345/artifacts/art_patch.patch') {
                return {
                  async text() {
                    return 'diff --git a/src/app.ts b/src/app.ts\n+const from-source-bundles = true;\n';
                  },
                };
              }
              return null;
            },
            async put() {
              return;
            },
          },
        },
        deploymentResultArtifact: {
          reviewDiffArtifactId: 'art_patch',
        },
        workspaceArtifactLookup: {
          objectKey: 'workspaces/ws_abc12345/artifacts/art_patch.patch',
          patchText: 'unused',
        },
        deploymentEvents: [],
      });
      await processReviewRun(env as never, 'rev_abcd1234');
      assert.equal(state.status, 'succeeded');
      assert.equal(firstPrompt.includes('const from-source-bundles = true'), true);
    } finally {
      globalThis.fetch = originalFetch;
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }
}
