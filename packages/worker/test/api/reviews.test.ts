import { strict as assert } from 'assert';
import { handleCreateReview, handleFailReview, handleGetReview, handleGetReviewEvents, handleListReviews, handleRecoverReview } from '../../src/api/reviews.js';
import { handleCreateReviewSessionPass } from '../../src/api/review-sessions.js';
import { setWorkspaceSandboxResolverForTests } from '../../src/api/workspaces/sandbox.js';
import { setReviewAnalysisSandboxResolverForTests } from '../../src/lib/review-analysis.js';

const TEST_SOURCE_BUNDLE_SHA256 = '6189e319ec3a587c508e6aa679e149462bcff5c4c1f64dc8b50a57e82937e7d4';

function withRequiredProvenance(payload: Record<string, unknown>): Record<string, unknown> {
  const provenance =
    payload.provenance && typeof payload.provenance === 'object' && !Array.isArray(payload.provenance)
      ? (payload.provenance as Record<string, unknown>)
      : {};
  return {
    ...payload,
    provenance: {
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      ...provenance,
    },
  };
}

function createReviewApiEnv(options?: {
  deploymentStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  reused?: boolean;
  reviewExists?: boolean;
  workspaceStatus?: 'ready' | 'deleted';
  initialReviewStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  reviewStatusSequence?: Array<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>;
  reviewEventBatches?: Array<
    Array<{
      seq: number;
      event_type: string;
      payload_json: string;
      created_at: string;
    }>
  >;
  existingEventTypes?: string[];
  reviewErrorCode?: string | null;
  reviewAttemptCount?: number;
  existingRequestPayloadSha256?: string;
  workerReviewGithubToken?: string;
  workspaceAccountId?: string | null;
  storedReviewRequestPayload?: Record<string, unknown>;
  reviewListRows?: Array<Record<string, unknown>>;
  sessionExists?: boolean;
  sessionId?: string;
}): {
  env: Record<string, unknown>;
  state: {
    reviewExists: boolean;
    queueSendCount: number;
    eventTypes: Set<string>;
    reviewStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    reviewErrorCode: string | null;
    reviewErrorMessage: string | null;
    createdRequestPayload: Record<string, unknown> | null;
    createdReviewAccountId: string | null;
    queuedMessages: Array<Record<string, unknown>>;
    findingsClearedCount: number;
  };
} {
  const state = {
    reviewExists: options?.reviewExists ?? false,
    reviewSessionExists: options?.sessionExists ?? false,
    reviewSessionId: options?.sessionId ?? (options?.reused ? 'session_existing' : null as string | null),
    queueSendCount: 0,
    eventTypes: new Set<string>(options?.existingEventTypes ?? []),
    reviewStatus: (options?.initialReviewStatus ?? 'queued') as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
    reviewErrorCode: options?.reviewErrorCode ?? null,
    reviewErrorMessage: options?.reviewErrorCode ? 'simulated review error' : null,
    reviewStatusReads: 0,
    reviewEventReads: 0,
    createdRequestPayload: null as Record<string, unknown> | null,
    createdReviewAccountId: null as string | null,
    queuedMessages: [] as Array<Record<string, unknown>>,
    findingsClearedCount: 0,
  };

  const env = {
    REVIEW_CONTEXT_GITHUB_TOKEN: options?.workerReviewGithubToken ?? 'ghp_worker_default_token_abcdefghijklmnopqrstuvwxyz',
    REVIEWS_QUEUE: {
      async send(message: unknown) {
        state.queueSendCount += 1;
        state.queuedMessages.push((message as Record<string, unknown>) ?? {});
      },
    },
    ReviewRunner: {
      idFromName(name: string) {
        return `do-${name}`;
      },
      get() {
        return {
          async fetch() {
            return new Response(JSON.stringify({ accepted: true }), { status: 202 });
          },
        };
      },
    },
    SOURCE_BUNDLES: {
      async get(key: string) {
        if (key !== 'key') {
          return null;
        }
        return {
          async arrayBuffer() {
            return new TextEncoder().encode('artifact bundle bytes').buffer;
          },
        };
      },
    },
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_abc12345',
                    status: options?.workspaceStatus ?? 'ready',
                    source_type: 'checkpoint',
                    checkpoint_id: null,
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'key',
                    source_bundle_sha256: TEST_SOURCE_BUNDLE_SHA256,
                    source_bundle_bytes: 1,
                    sandbox_id: 'workspace-ws_abc12345',
                    baseline_ready: 1,
                    error_code: null,
                    error_message: null,
                    last_deployment_id: 'dep_abcd1234',
                    last_deployment_status: options?.deploymentStatus ?? 'succeeded',
                    last_deployed_url: 'https://example.com',
                    last_deployed_at: '2026-03-11T00:00:00.000Z',
                    last_deployment_error_code: null,
                    last_deployment_error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                    deleted_at: options?.workspaceStatus === 'deleted' ? '2026-03-11T00:00:00.000Z' : null,
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT account_id FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    account_id:
                      options && 'workspaceAccountId' in options ? (options.workspaceAccountId ?? null) : 'acct_123',
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
                    status: options?.deploymentStatus ?? 'succeeded',
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
                    last_event_seq: 0,
                    cancel_requested_at: null,
                    started_at: '2026-03-11T00:00:00.000Z',
                    finished_at: '2026-03-11T00:01:00.000Z',
                    duration_ms: 60000,
                    result_json: '{}',
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

        if (/SELECT review_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (!options?.reused) {
                    return null as T;
                  }
                    return {
                      review_id: 'rev_existing',
                      request_payload_sha256:
                      options?.existingRequestPayloadSha256 ?? '2babb228edb21a131fef0051902a367e6ad34a301a0f6b293e11b36a9a39423d',
                      expires_at: '2999-01-01T00:00:00.000Z',
                    } as T;
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

        if (/INSERT INTO review_sessions/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.reviewSessionExists = true;
                  state.reviewSessionId = typeof values[0] === 'string' ? values[0] : null;
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

        if (/DELETE FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async run() {
                  if (state.reviewSessionId === sessionId) {
                    state.reviewSessionExists = false;
                    state.reviewSessionId = null;
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_sessions\s+SET active_review_id = \?/i.test(sql)) {
          return {
            bind(reviewId: string, _latestReviewId: string, _reviewIdForCount: string) {
              return {
                async run() {
                  state.reviewSessionExists = true;
                  state.reviewSessionId = state.reviewSessionId ?? 'session_created';
                  state.reviewExists = true;
                  state.createdReviewAccountId = state.createdReviewAccountId ?? 'acct_123';
                  state.eventTypes.add(`session:${reviewId}`);
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
                  const resolvedSessionId = state.reviewSessionExists ? state.reviewSessionId : null;
                  if (!resolvedSessionId || sessionId !== resolvedSessionId) {
                    return null as T;
                  }
                  return {
                    id: resolvedSessionId,
                    workspace_id: 'ws_abc12345',
                    anchor_deployment_id: 'dep_abcd1234',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'a'.repeat(40),
                    anchor_checkpoint_id: null,
                    source_project_root: '.',
                    active_review_id: state.reviewExists ? 'rev_abcd1234' : 'rev_existing',
                    latest_review_id: state.reviewExists ? 'rev_abcd1234' : 'rev_existing',
                    pass_count: 1,
                    stop_reason: null,
                    account_id:
                      options && 'workspaceAccountId' in options ? (options.workspaceAccountId ?? null) : 'acct_123',
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT account_id FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async first<T>() {
                  const resolvedSessionId = state.reviewSessionExists ? state.reviewSessionId : null;
                  if (!resolvedSessionId || sessionId !== resolvedSessionId) {
                    return null as T;
                  }
                  return {
                    account_id:
                      options && 'workspaceAccountId' in options ? (options.workspaceAccountId ?? null) : 'acct_123',
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT id, session_id, status, request_payload_json, created_at, started_at, finished_at\s+FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind(sessionId: string) {
              return {
                async all<T>() {
                  const resolvedSessionId = state.reviewSessionExists ? state.reviewSessionId : null;
                  if (!resolvedSessionId || sessionId !== resolvedSessionId) {
                    return { results: [] } as unknown as T;
                  }
                  return {
                    results: [
                      {
                        id: state.reviewExists ? 'rev_abcd1234' : 'rev_existing',
                        session_id: resolvedSessionId,
                        status: state.reviewStatus,
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

        if (/INSERT INTO review_runs/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.reviewExists = true;
                  try {
                    state.createdRequestPayload = JSON.parse(String(values[8])) as Record<string, unknown>;
                  } catch {
                    state.createdRequestPayload = null;
                  }
                  state.createdReviewAccountId = typeof values[10] === 'string' ? values[10] : null;
                  state.reviewSessionExists = typeof values[3] === 'string' && values[3].trim().length > 0;
                  state.reviewSessionId = typeof values[3] === 'string' ? values[3] : state.reviewSessionId;
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

        if (/SELECT 1\s+FROM review_events/i.test(sql)) {
          return {
            bind(_reviewId: string, eventType: string) {
              return {
                async first<T>() {
                  return state.eventTypes.has(eventType) ? ({ '1': 1 } as T) : (null as T);
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
                  return { last_event_seq: state.eventTypes.size + 1 } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind(_reviewId: string, _seq: number, eventType: string) {
              return {
                async run() {
                  state.eventTypes.add(eventType);
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
                  state.findingsClearedCount += 1;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET /i.test(sql) && !/last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  if (typeof values[0] === 'string') {
                    state.reviewStatus = values[0] as typeof state.reviewStatus;
                  }
                  for (let index = 0; index < values.length; index += 1) {
                    const value = values[index];
                    if (value === 'retry_scheduled' || value === 'review_execution_timeout' || value === 'review_execution_aborted') {
                      state.reviewErrorCode = value;
                    }
                    if (
                      typeof value === 'string' &&
                      index > 0 &&
                      (values[index - 1] === 'retry_scheduled' || values[index - 1] === 'review_execution_timeout' || values[index - 1] === 'review_execution_aborted')
                    ) {
                      state.reviewErrorMessage = value;
                    }
                  }
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
                  if (!state.reviewExists && !(options?.reused && reviewId === 'rev_existing')) {
                    return null as T;
                  }
                  const sequence = options?.reviewStatusSequence;
                  const statusFromSequence =
                    sequence && sequence.length > 0
                      ? sequence[Math.min(state.reviewStatusReads, sequence.length - 1)]
                      : state.reviewStatus;
                  state.reviewStatusReads += 1;
                  return {
                    id: reviewId,
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    session_id: state.reviewSessionId,
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: statusFromSequence,
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    last_event_seq: 1,
                    attempt_count: options?.reviewAttemptCount ?? 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: state.reviewErrorCode,
                    error_message: state.reviewErrorMessage,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+ORDER BY created_at DESC\s+LIMIT \?/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results:
                      options?.reviewListRows ??
                      [
                        {
                          id: 'rev_list_1',
                          workspace_id: 'ws_abc12345',
                          deployment_id: 'dep_abcd1234',
                          session_id: 'session_list_1',
                          target_type: 'workspace_deployment',
                          mode: 'report_only',
                          status: 'queued',
                          idempotency_key: 'idem-review',
                          request_payload_json: '{}',
                          request_payload_sha256: 'hash',
                          provenance_json: '{}',
                          repo: 'dayhaysoos/nimbus',
                          branch: 'main',
                          derived_policy_json: null,
                          approved_policy_json: null,
                          approved_policy_sha256: null,
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
                        },
                      ],
                  } as unknown as T;
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
                  return {
                    request_payload_json: JSON.stringify(options?.storedReviewRequestPayload ?? {}),
                  } as T;
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
                  const batches = options?.reviewEventBatches;
                  const batch =
                    batches && batches.length > 0
                      ? batches[Math.min(state.reviewEventReads, batches.length - 1)]
                      : [
                          {
                            seq: 1,
                            event_type: 'review_created',
                            payload_json: '{"ok":true}',
                            created_at: '2026-03-11T00:00:00.000Z',
                          },
                        ];
                  state.reviewEventReads += 1;
                  return {
                    results: batch,
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
    },
  };

  return { env, state };
}

export async function runReviewApiTests(): Promise<void> {
  let waitUntilCount = 0;
  const ctx = {
    waitUntil() {
      waitUntilCount += 1;
    },
  } as unknown as ExecutionContext;

  {
    const { env } = createReviewApiEnv();
    delete (env as { ReviewRunner?: unknown }).ReviewRunner;
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-missing-runner' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 503);
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('http://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-http-hosted' },
    });
    const response = await handleCreateReview(request, env as never, ctx, {
      accountId: 'acct_123',
      isAdmin: false,
      isAuthenticated: true,
      isHostedMode: true,
    });
    assert.equal(response.status, 400);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('http://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-http-self-hosted' },
    });
    const response = await handleCreateReview(request, env as never, ctx, {
      accountId: 'self-hosted',
      isAdmin: true,
      isAuthenticated: false,
      isHostedMode: false,
    });
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createReviewApiEnv({ workerReviewGithubToken: '' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-missing-token' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    // Missing scoped token is accepted at create time; execution may fail asynchronously
    // with review_context_github_token_missing when local co-change provenance is unavailable.
    assert.equal(response.status, 202);
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: '' });
    const createRequest = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-missing-token-async' },
    });
    const createResponse = await handleCreateReview(createRequest, env as never, ctx);
    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as { reviewId: string };
    state.reviewStatus = 'failed';
    const getResponse = await handleGetReview(
      created.reviewId,
      new Request(`https://example.com/api/reviews/${created.reviewId}`),
      env as never
    );
    assert.equal(getResponse.status, 200);
    const body = (await getResponse.json()) as { review?: { status?: string } };
    assert.equal(body.review?.status, 'failed');
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        model: '   ',
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-invalid-model' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env, state } = createReviewApiEnv();
    waitUntilCount = 0;
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          policy: { severityThreshold: ' medium ' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-trimmed-threshold' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          policyMode: 'auto',
          reviewBasis: 'environment',
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-policy-mode-auto' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.createdRequestPayload?.policyMode, 'auto');
    assert.equal(state.createdRequestPayload?.reviewBasis, 'environment');
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          policyMode: 'invalid',
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-policy-mode-invalid' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          reviewBasis: 'invalid',
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-review-basis-invalid' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            note: 'Use commit intent context from Entire history',
            sessionIds: ['ses_123', 'ses_123', '', 'ses_456'],
            transcriptUrl: 'https://example.com/transcript',
            intentSessionContext: ['Focus on auth regression risk.', 'Focus on auth regression risk.', ''],
          },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-provenance' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    const createdProvenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
    assert.deepEqual(createdProvenance, {
      trigger: 'api',
      reviewContextMode: 'intent_aware',
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      note: 'Use commit intent context from Entire history',
      sessionIds: ['ses_123', 'ses_456'],
      transcriptUrl: 'https://example.com/transcript',
      intentSessionContext: ['Focus on auth regression risk.'],
    });
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            commitSha: 'a'.repeat(40),
            commitDiffPatch: 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
          },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-commit-provenance' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    const createdProvenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
    assert.equal(createdProvenance.trigger, 'api');
    assert.equal(createdProvenance.commitSha, 'a'.repeat(40));
    assert.equal(typeof createdProvenance.commitDiffPatch, 'string');
    assert.equal(String(createdProvenance.commitDiffPatch).includes('diff --git'), true);
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: '' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            localCochange: {
              source: 'local_git',
              checkpointsRef: 'refs/remotes/origin/entire/checkpoints/v1',
              lookbackSessions: 5,
              topN: 20,
              sessionsScanned: 2,
              relatedByChangedPath: {
                'src/app.ts': [{ path: 'src/config.ts', frequency: 2, sessionIds: ['ses_1', 'ses_2'] }],
              },
            },
          },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-local-cochange' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    const createdProvenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
    const localCochange = createdProvenance.localCochange as Record<string, unknown>;
    assert.equal(localCochange.source, 'local_git');
    assert.equal(localCochange.lookbackSessions, 5);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          model: ' sonnet-4.5 ',
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-model-override' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.createdRequestPayload?.model, 'sonnet-4.5');
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: '' });
    waitUntilCount = 0;
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        }),
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-header-token',
        'X-Review-Github-Token': 'ghp_aaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
    assert.equal(waitUntilCount, 0);
    assert.equal(JSON.stringify(state.createdRequestPayload ?? {}).includes('ghp_aaaaaaaaaaaaaaaaaaaaa'), false);
    assert.equal((state.createdRequestPayload as Record<string, unknown> | null)?.['review_context_github_token'], undefined);
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: 'ghp_worker_token_abc' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        }),
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-openrouter-header',
        'X-Openrouter-Api-Key': 'or_user_token_123',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queuedMessages.length, 1);
    assert.equal(state.queuedMessages[0]?.openrouterApiKey, 'or_user_token_123');
    assert.equal(state.createdReviewAccountId, 'acct_123');
    assert.equal(JSON.stringify(state.createdRequestPayload ?? {}).includes('or_user_token_123'), false);
  }

  {
    const { env, state } = createReviewApiEnv({ workspaceAccountId: 'acct_workspace_owner' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        }),
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-account-source',
      },
    });
    const response = await handleCreateReview(
      request,
      env as never,
      ctx,
      { accountId: 'acct_admin_requester', isAdmin: true, isAuthenticated: true, isHostedMode: true }
    );
    assert.equal(response.status, 202);
    assert.equal(state.createdReviewAccountId, 'acct_workspace_owner');
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: 'ghp_worker_token_abc' });
    waitUntilCount = 0;
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-header-and-worker-token',
        'X-Review-Github-Token': 'ghp_aaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
    assert.equal(waitUntilCount, 0);
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          policy: { severityThreshold: 'medum' },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-invalid-threshold' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            repo: `owner/${'r'.repeat(260)}`,
          },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-invalid-repo-length' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'invalid_review_provenance');
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            branch: 'b'.repeat(256),
          },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-invalid-branch-length' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'invalid_review_provenance');
  }

  {
    const { env } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'git_diff', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-1' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createReviewApiEnv({ deploymentStatus: 'failed' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-2' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-3' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv({ reused: true, reviewExists: true });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-4' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingRequestPayloadSha256: 'f004b542a0ca344c9a93ab94447edbb0ec52d21236f442491bac726f7430c745',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-conflict' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingRequestPayloadSha256: 'f004b542a0ca344c9a93ab94447edbb0ec52d21236f442491bac726f7430c745',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          model: 'sonnet-4.5-review-override',
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-conflict' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.createdRequestPayload, null);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingRequestPayloadSha256: 'f004b542a0ca344c9a93ab94447edbb0ec52d21236f442491bac726f7430c745',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            localCochange: {
              source: 'invalid_source',
              relatedByChangedPath: {},
            },
          },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-conflict' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingRequestPayloadSha256: 'f004b542a0ca344c9a93ab94447edbb0ec52d21236f442491bac726f7430c745',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        ...withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
          provenance: {
            commitDiffPatchSha256: 'a'.repeat(64),
            commitDiffPatchTruncated: true,
            commitDiffPatchOriginalChars: 120001,
          },
        }),
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-conflict' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.createdRequestPayload, null);
  }

  {
    const { env, state } = createReviewApiEnv({ reused: true, reviewExists: true, workspaceStatus: 'deleted' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-4c' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'missing_openrouter_api_key',
      reviewAttemptCount: 1,
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-4b',
        'X-Review-Github-Token': 'ghp_aaaaaaaaaaaaaaaaaaaaa',
        'X-Openrouter-Api-Key': 'or_user_retry_key',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'missing_openrouter_api_key',
      reviewAttemptCount: 1,
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-4b-no-openrouter',
        'X-Review-Github-Token': 'ghp_aaaaaaaaaaaaaaaaaaaaa',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'Idempotency key has already been used with different payload');
    assert.equal(body.code, 'idempotency_key_conflict');
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'retry_scheduled',
      reviewAttemptCount: 1,
      workerReviewGithubToken: '',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-recovered-no-scoped-token' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'idempotency_key_conflict');
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'retry_scheduled',
      reviewAttemptCount: 1,
      workerReviewGithubToken: '',
      storedReviewRequestPayload: {
        provenance: {
          localCochange: {
            source: 'local_git',
            relatedByChangedPath: {
              'src/file.ts': [],
            },
          },
        },
      },
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-recovered-local-cochange-empty' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'retry_scheduled',
      reviewAttemptCount: 1,
      workerReviewGithubToken: '',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify(
        withRequiredProvenance({
          target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        })
      ),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-recovered-invalid-token',
        'X-Review-Github-Token': 'invalid-token-value',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'idempotency_key_conflict');
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({ reviewExists: true });
    state.reviewStatus = 'succeeded';
    const response = await handleGetReview('rev_abcd1234', new Request('https://example.com/api/reviews/rev_abcd1234'), env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env, state } = createReviewApiEnv({ reviewExists: true, workerReviewGithubToken: '' });
    state.reviewStatus = 'running';
    (env as { ATTEMPT_TIMEOUT_MS?: string }).ATTEMPT_TIMEOUT_MS = '1';
    const response = await handleGetReview('rev_abcd1234', new Request('https://example.com/api/reviews/rev_abcd1234'), env as never);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({ reviewExists: true, workerReviewGithubToken: '' });
    state.reviewStatus = 'running';
    (env as { ATTEMPT_TIMEOUT_MS?: string }).ATTEMPT_TIMEOUT_MS = '1';
    const response = await handleGetReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234', {
        headers: { 'X-Review-Github-Token': 'ghp_aaaaaaaaaaaaaaaaaaaaa' },
      }),
      env as never
    );
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env } = createReviewApiEnv({
      reviewExists: true,
      reviewStatusSequence: ['running', 'succeeded', 'succeeded', 'succeeded'],
      reviewEventBatches: [
        [
          {
            seq: 1,
            event_type: 'review_created',
            payload_json: '{"ok":true}',
            created_at: '2026-03-11T00:00:00.000Z',
          },
        ],
        [],
        [
          {
            seq: 2,
            event_type: 'review_succeeded',
            payload_json: '{"recommendation":"approve"}',
            created_at: '2026-03-11T00:00:01.000Z',
          },
        ],
        [],
      ],
    });
    const response = await handleGetReviewEvents(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/events?from=0'),
      env as never
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    const text = await response.text();
    assert.match(text, /"type":"review_created"/);
    assert.match(text, /"type":"snapshot"/);
    assert.match(text, /"type":"review_succeeded"/);
    assert.match(text, /"type":"terminal"/);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'queued',
      reviewAttemptCount: 1,
      storedReviewRequestPayload: {
        provenance: {
          localCochange: {
            source: 'local_git',
            relatedByChangedPath: {
              'src/app.ts': [{ path: 'src/config.ts', frequency: 2, sessionIds: ['ses_1', 'ses_2'] }],
            },
          },
        },
      },
    });
    const response = await handleRecoverReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/recover', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.action, 'requeued');
    const review = (body.review ?? {}) as Record<string, unknown>;
    assert.equal(review.status, 'queued');
    assert.equal(state.queueSendCount, 1);
    assert.equal(state.eventTypes.has('review_retry_scheduled'), true);
    assert.equal(state.reviewErrorCode, 'retry_scheduled');
    assert.equal(state.findingsClearedCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'running',
      reviewAttemptCount: 1,
      storedReviewRequestPayload: {
        provenance: {
          localCochange: {
            source: 'local_git',
            relatedByChangedPath: {
              'src/app.ts': [{ path: 'src/config.ts', frequency: 2, sessionIds: ['ses_1', 'ses_2'] }],
            },
          },
        },
      },
    });
    const response = await handleRecoverReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/recover', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 409);
    assert.equal(state.queueSendCount, 0);
    assert.equal(state.eventTypes.has('review_retry_scheduled'), false);
    assert.equal(state.reviewStatus, 'running');
    assert.equal(state.findingsClearedCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'queued',
      reviewAttemptCount: 5,
      storedReviewRequestPayload: {
        provenance: {},
      },
    });
    const response = await handleRecoverReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/recover', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.action, 'failed');
    const review = (body.review ?? {}) as Record<string, unknown>;
    assert.equal(review.status, 'failed');
    assert.equal(state.queueSendCount, 0);
    assert.equal(state.eventTypes.has('review_failed'), true);
    assert.equal(state.reviewErrorCode, 'review_execution_timeout');
    assert.equal(state.findingsClearedCount, 0);
  }

  {
    const { env } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'succeeded',
    });
    const response = await handleRecoverReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/recover', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 409);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'running',
    });
    const response = await handleFailReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/fail', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.action, 'failed');
    const review = (body.review ?? {}) as Record<string, unknown>;
    assert.equal(review.status, 'failed');
    assert.equal(state.eventTypes.has('review_failed'), true);
    assert.equal(state.reviewErrorCode, 'review_execution_aborted');
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'running',
      reviewAttemptCount: 2,
    });
    const db = env.DB as {
      prepare: (sql: string) => {
        bind: (...args: unknown[]) => {
          first?: <T>() => Promise<T>;
          run?: () => Promise<{ success: boolean; meta?: { changes?: number } }>;
        };
      };
    };
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!/UPDATE review_runs SET /i.test(sql) || /last_event_seq = last_event_seq \+ 1/i.test(sql)) {
        return statement;
      }
      return {
        bind(...values: unknown[]) {
          if (values[0] !== 'failed') {
            return statement.bind(...values);
          }
          return {
            async run() {
              state.reviewStatus = 'succeeded';
              state.reviewErrorCode = null;
              state.reviewErrorMessage = null;
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    }) as typeof db.prepare;

    const response = await handleFailReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/fail', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.action, 'unchanged');
    const review = (body.review ?? {}) as Record<string, unknown>;
    assert.equal(review.status, 'succeeded');
    assert.equal(state.eventTypes.has('review_failed'), false);
    assert.equal(state.reviewErrorCode, null);
  }

  {
    const { env } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'succeeded',
    });
    const response = await handleFailReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/fail', { method: 'POST' }),
      env as never
    );
    assert.equal(response.status, 409);
  }

  {
    const { env, state } = createReviewApiEnv({
      reviewExists: true,
      initialReviewStatus: 'queued',
      reviewAttemptCount: 1,
      storedReviewRequestPayload: {
        provenance: {},
      },
    });
    const response = await handleRecoverReview(
      'rev_abcd1234',
      new Request('https://example.com/api/reviews/rev_abcd1234/recover', {
        method: 'POST',
        headers: {
          'X-Review-Github-Token': 'not-a-scoped-token',
        },
      }),
      env as never
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body.error, 'string');
    assert.equal(String(body.error).includes('invalid'), true);
    assert.equal(state.queueSendCount, 0);
    assert.equal(state.eventTypes.has('review_failed'), false);
    assert.equal(state.reviewStatus, 'queued');
    assert.equal(state.findingsClearedCount, 0);
  }

  {
    setReviewAnalysisSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
    }) as never);
    try {
      const { env, state } = createReviewApiEnv({
        sessionExists: true,
        sessionId: 'session_existing',
        initialReviewStatus: 'succeeded',
      });
      const response = await handleCreateReviewSessionPass(
        'session_existing',
        new Request('https://example.com/api/review-sessions/session_existing/reviews', {
          method: 'POST',
          body: JSON.stringify({
            reviewBasis: 'environment',
            policy: {
              severityThreshold: 'medium',
              maxFindings: 12,
            },
          }),
        }),
        env as never
      );
      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.sessionId, 'session_existing');
      assert.equal(body.status, 'queued');
      assert.equal(state.queueSendCount, 1);
      assert.equal(state.createdRequestPayload?.reviewBasis, 'environment');
      const provenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
      const environmentRevision = (provenance.environmentRevision ?? {}) as Record<string, unknown>;
      assert.equal(environmentRevision.source, 'workspace_head');
      assert.equal(typeof environmentRevision.diffSha256, 'string');
      assert.equal(environmentRevision.changedFileCount, 0);
    } finally {
      setReviewAnalysisSandboxResolverForTests(null);
    }
  }

  {
    const { env, state } = createReviewApiEnv({
      sessionExists: true,
      sessionId: 'session_existing',
      initialReviewStatus: 'succeeded',
      storedReviewRequestPayload: {
        provenance: {
          reviewContextMode: 'intent_aware',
          sessionIds: ['ses_old_1'],
          intentSessionContext: ['Old intent context'],
          environmentRevision: {
            source: 'workspace_head',
            diffSha256: 'a'.repeat(64),
            changedFileCount: 3,
            generatedAt: '2026-03-11T00:00:00.000Z',
          },
        },
      },
    });
    const response = await handleCreateReviewSessionPass(
      'session_existing',
      new Request('https://example.com/api/review-sessions/session_existing/reviews', {
        method: 'POST',
        body: JSON.stringify({ reviewBasis: 'checkpoint' }),
      }),
      env as never
    );
    assert.equal(response.status, 202);
    const createdProvenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
    assert.equal(createdProvenance.reviewContextMode, 'intent_aware');
    assert.deepEqual(createdProvenance.sessionIds, ['ses_old_1']);
    assert.equal(createdProvenance.environmentRevision, undefined);
  }

  {
    const { env, state } = createReviewApiEnv({
      sessionExists: true,
      sessionId: 'session_existing',
      initialReviewStatus: 'succeeded',
      deploymentStatus: 'failed',
    });
    const response = await handleCreateReviewSessionPass(
      'session_existing',
      new Request('https://example.com/api/review-sessions/session_existing/reviews', {
        method: 'POST',
        body: JSON.stringify({ reviewBasis: 'checkpoint' }),
      }),
      env as never
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'deployment_not_reviewable');
    assert.equal(state.queueSendCount, 0);
  }

  {
    const { env, state } = createReviewApiEnv({
      sessionExists: true,
      sessionId: 'session_existing',
      initialReviewStatus: 'succeeded',
    });
    const response = await handleCreateReviewSessionPass(
      'session_existing',
      new Request('https://example.com/api/review-sessions/session_existing/reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': '   ',
        },
        body: JSON.stringify({ reviewBasis: 'checkpoint' }),
      }),
      env as never
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'missing_idempotency_key');
    assert.equal(state.queueSendCount, 0);
  }

  {
    let hasHead = false;
    const sandboxResolver = async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: hasHead ? 0 : 2 };
        }
        if (command.includes('git init -q')) {
          hasHead = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 -d') || command.includes('cat ') || command.includes('rm -rf')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git read-tree HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
    });
    setReviewAnalysisSandboxResolverForTests(sandboxResolver as never);
    setWorkspaceSandboxResolverForTests(sandboxResolver as never);
    try {
      const { env, state } = createReviewApiEnv({
        sessionExists: true,
        sessionId: 'session_existing',
        initialReviewStatus: 'succeeded',
      });
      const response = await handleCreateReviewSessionPass(
        'session_existing',
        new Request('https://example.com/api/review-sessions/session_existing/reviews', {
          method: 'POST',
          body: JSON.stringify({ reviewBasis: 'environment' }),
        }),
        env as never
      );
      assert.equal(response.status, 202);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(typeof body.reviewId, 'string');
      assert.equal(body.sessionId, 'session_existing');
      assert.equal(state.queueSendCount, 1);
      assert.equal(hasHead, true);
    } finally {
      setReviewAnalysisSandboxResolverForTests(null);
      setWorkspaceSandboxResolverForTests(null);
    }
  }

  {
    const { env } = createReviewApiEnv({
      sessionExists: true,
      sessionId: 'session_existing',
      initialReviewStatus: 'running',
    });
    const response = await handleCreateReviewSessionPass(
      'session_existing',
      new Request('https://example.com/api/review-sessions/session_existing/reviews', {
        method: 'POST',
        body: JSON.stringify({ reviewBasis: 'environment' }),
      }),
      env as never
    );
    assert.equal(response.status, 409);
  }

  {
    const { env } = createReviewApiEnv();
    const response = await handleListReviews(new Request('https://example.com/api/reviews?limit=10'), env as never);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    const reviews = Array.isArray(body.reviews) ? body.reviews : [];
    assert.equal(reviews.length, 1);
    assert.equal((reviews[0] as Record<string, unknown>).id, 'rev_list_1');
  }

  {
    const { env } = createReviewApiEnv();
    const response = await handleListReviews(new Request('https://example.com/api/reviews?repo=invalid_repo'), env as never);
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'invalid_review_query');
  }

  {
    const { env } = createReviewApiEnv();
    const response = await handleGetReview('rev_missing', new Request('https://example.com/api/reviews/rev_missing'), env as never);
    assert.equal(response.status, 404);
  }
}
