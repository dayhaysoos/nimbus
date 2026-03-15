import { strict as assert } from 'assert';
import { handleCreateReview, handleGetReview, handleGetReviewEvents } from './reviews.js';

function createReviewApiEnv(options?: {
  deploymentStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  reused?: boolean;
  reviewExists?: boolean;
  workspaceStatus?: 'ready' | 'deleted';
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
}): {
  env: Record<string, unknown>;
  state: {
    reviewExists: boolean;
    queueSendCount: number;
    eventTypes: Set<string>;
    reviewStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    createdRequestPayload: Record<string, unknown> | null;
  };
} {
  const state = {
    reviewExists: options?.reviewExists ?? false,
    queueSendCount: 0,
    eventTypes: new Set<string>(options?.existingEventTypes ?? []),
    reviewStatus: 'queued' as const,
    reviewStatusReads: 0,
    reviewEventReads: 0,
    createdRequestPayload: null as Record<string, unknown> | null,
  };

  const env = {
    REVIEW_CONTEXT_GITHUB_TOKEN: options?.workerReviewGithubToken ?? 'ghp_worker_default_token_abcdefghijklmnopqrstuvwxyz',
    REVIEWS_QUEUE: {
      async send() {
        state.queueSendCount += 1;
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
                    source_bundle_sha256: 'f'.repeat(64),
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
                  return { account_id: 'acct_123' } as T;
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

        if (/INSERT INTO review_runs/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.reviewExists = true;
                  try {
                    state.createdRequestPayload = JSON.parse(String(values[6])) as Record<string, unknown>;
                  } catch {
                    state.createdRequestPayload = null;
                  }
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
                    account_id: values[8],
                    provenance_json: values[9],
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
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: statusFromSequence,
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    last_event_seq: 1,
                    attempt_count: options?.reviewAttemptCount ?? 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: options?.reviewErrorCode ?? null,
                    error_message: null,
                    created_at: '2026-03-11T00:00:00.000Z',
                    updated_at: '2026-03-11T00:00:00.000Z',
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
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-missing-token' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 400);
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
      body: JSON.stringify({
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        policy: { severityThreshold: ' medium ' },
      }),
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
      body: JSON.stringify({
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        provenance: {
          note: 'Use commit intent context from Entire history',
          sessionIds: ['ses_123', 'ses_123', '', 'ses_456'],
          transcriptUrl: 'https://example.com/transcript',
          intentSessionContext: ['Focus on auth regression risk.', 'Focus on auth regression risk.', ''],
        },
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-provenance' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    const createdProvenance = (state.createdRequestPayload?.provenance ?? {}) as Record<string, unknown>;
    assert.deepEqual(createdProvenance, {
      trigger: 'api',
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        provenance: {
          commitSha: 'a'.repeat(40),
          commitDiffPatch: 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
        },
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        model: ' sonnet-4.5 ',
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-header-token',
        'X-Review-Github-Token': 'ghp_user_token_123',
      },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.queueSendCount, 1);
    assert.equal(waitUntilCount, 0);
    assert.equal(JSON.stringify(state.createdRequestPayload ?? {}).includes('ghp_user_token_123'), false);
    assert.equal((state.createdRequestPayload as Record<string, unknown> | null)?.['review_context_github_token'], undefined);
  }

  {
    const { env, state } = createReviewApiEnv({ workerReviewGithubToken: 'ghp_worker_token_abc' });
    waitUntilCount = 0;
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
      }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-review-header-and-worker-token',
        'X-Review-Github-Token': 'ghp_user_token_456',
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        policy: { severityThreshold: 'medum' },
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
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-2' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
  }

  {
    const { env, state } = createReviewApiEnv();
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
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
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-4' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingRequestPayloadSha256: 'f004b542a0ca344c9a93ab94447edbb0ec52d21236f442491bac726f7430c745',
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-legacy' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        model: 'sonnet-4.5-review-override',
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-legacy' },
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        provenance: {
          localCochange: {
            source: 'invalid_source',
            relatedByChangedPath: {},
          },
        },
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-legacy' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
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
        target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' },
        provenance: {
          commitDiffPatchSha256: 'a'.repeat(64),
          commitDiffPatchTruncated: true,
          commitDiffPatchOriginalChars: 120001,
        },
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-legacy' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 409);
    assert.equal(state.createdRequestPayload, null);
  }

  {
    const { env, state } = createReviewApiEnv({ reused: true, reviewExists: true, workspaceStatus: 'deleted' });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-4c' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv({
      reused: true,
      reviewExists: true,
      existingEventTypes: ['review_enqueued'],
      reviewErrorCode: 'retry_scheduled',
      reviewAttemptCount: 1,
    });
    const request = new Request('https://example.com/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ target: { type: 'workspace_deployment', workspaceId: 'ws_abc12345', deploymentId: 'dep_abcd1234' } }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-review-4b' },
    });
    const response = await handleCreateReview(request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createReviewApiEnv({ reviewExists: true });
    state.reviewStatus = 'succeeded';
    const response = await handleGetReview('rev_abcd1234', env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env, state } = createReviewApiEnv({ reviewExists: true, workerReviewGithubToken: '' });
    state.reviewStatus = 'running';
    (env as { ATTEMPT_TIMEOUT_MS?: string }).ATTEMPT_TIMEOUT_MS = '1';
    const response = await handleGetReview('rev_abcd1234', env as never);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 0);
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
    const { env } = createReviewApiEnv();
    const response = await handleGetReview('rev_missing', env as never);
    assert.equal(response.status, 404);
  }
}
