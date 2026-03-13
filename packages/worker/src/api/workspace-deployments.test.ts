import { strict as assert } from 'assert';
import {
  handleCancelWorkspaceDeployment,
  handleCreateWorkspaceDeployment,
  handleGetWorkspaceDeployment,
  handleGetWorkspaceDeploymentEvents,
  handleWorkspaceDeploymentPreflight,
} from './workspace-deployments.js';
import { setWorkspaceDeploymentSandboxResolverForTests } from '../lib/workspace-deployment-runner.js';

function createWorkspaceDeploymentApiEnv(options?: {
  workspaceStatus?: 'ready' | 'deleted';
  reuseRetryScheduled?: boolean;
  reuseFailed?: boolean;
  precheckClaimBlockedConcurrentFailed?: boolean;
  reuseRequestPayloadSha256?: string;
  sourceProjectRoot?: string;
}): {
  env: Record<string, unknown>;
  state: {
    deploymentExists: boolean;
    deploymentStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    cancelRequestedAt: string | null;
    deploymentErrorCode: string | null;
    eventTypes: Set<string>;
    queueSendCount: number;
    createdProvenance: Record<string, unknown> | null;
  };
} {
  const state: {
    deploymentExists: boolean;
    deploymentStatus: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    cancelRequestedAt: string | null;
    deploymentErrorCode: string | null;
    eventTypes: Set<string>;
    queueSendCount: number;
    createdProvenance: Record<string, unknown> | null;
  } = {
    deploymentExists: false,
    deploymentStatus: options?.reuseFailed ? 'failed' : 'queued',
    cancelRequestedAt: null,
    deploymentErrorCode: options?.reuseFailed ? 'provider_auth_failed' : options?.reuseRetryScheduled ? 'retry_scheduled' : null,
    eventTypes: options?.reuseRetryScheduled ? new Set<string>(['deployment_enqueued']) : new Set<string>(),
    queueSendCount: 0,
    createdProvenance: null,
  };

  const env = {
    WORKSPACE_DEPLOY_ENABLED: 'true',
    WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
    WORKSPACE_DEPLOY_PROJECT_NAME: 'nimbus',
    CF_ACCOUNT_ID: 'acc',
    CF_API_TOKEN: 'token',
    WORKSPACE_DEPLOYS_QUEUE: {
      async send() {
        state.queueSendCount += 1;
      },
    },
    DB: {
      prepare(sql: string) {
        if (/SELECT key, value FROM runtime_flags/i.test(sql)) {
          return {
            async all() {
              return { results: [] };
            },
          };
        }

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
                    source_project_root: options?.sourceProjectRoot ?? '.',
                    source_bundle_key: 'key',
                    source_bundle_sha256: 'f'.repeat(64),
                    source_bundle_bytes: 1,
                    sandbox_id: 'workspace-ws_abc12345',
                    baseline_ready: 1,
                    error_code: null,
                    error_message: null,
                    last_deployment_id: null,
                    last_deployment_status: null,
                    last_deployed_url: null,
                    last_deployed_at: null,
                    last_deployment_error_code: null,
                    last_deployment_error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-08T00:00:00.000Z',
                    updated_at: '2026-03-08T00:00:00.000Z',
                    deleted_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT deployment_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (!options?.reuseRetryScheduled && !options?.reuseFailed) {
                    return null as T;
                  }
                    return {
                      deployment_id: 'dep_existing',
                      request_payload_sha256:
                        options?.reuseRequestPayloadSha256 ??
                        '5c0025e03c59e65566863c1c186a0640fe3c01889fdf396ccd8e65bff4d0feb3',
                      expires_at: '2999-01-01T00:00:00.000Z',
                    } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_deployments/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.deploymentExists = true;
                  try {
                    state.createdProvenance = JSON.parse(String(values[7])) as Record<string, unknown>;
                  } catch {
                    state.createdProvenance = null;
                  }
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    status: 'queued',
                    provider: values[2],
                    idempotency_key: values[3],
                    request_payload_json: values[4],
                    request_payload_sha256: values[5],
                    max_retries: values[6],
                    attempt_count: 0,
                    source_snapshot_sha256: null,
                    source_bundle_key: null,
                    provenance_json: values[7],
                    provider_deployment_id: null,
                    deployed_url: null,
                    last_event_seq: 0,
                    cancel_requested_at: null,
                    started_at: null,
                    finished_at: null,
                    duration_ms: null,
                    result_json: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-08T00:00:00.000Z',
                    updated_at: '2026-03-08T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_deployment_idempotency/i.test(sql)) {
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

        if (/UPDATE workspace_deployments SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { last_event_seq: 1 } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_deployment_events/i.test(sql)) {
          return {
            bind(_workspaceId: string, _deploymentId: string, _seq: number, eventType: string) {
              return {
                async run() {
                  state.eventTypes.add(eventType);
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SET error_code = 'provider_precheck_running'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  if (options?.precheckClaimBlockedConcurrentFailed) {
                    state.deploymentStatus = 'failed';
                    state.deploymentErrorCode = 'provider_auth_failed';
                    return { success: true, meta: { changes: 0 } };
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT 1\s+FROM workspace_deployment_events/i.test(sql)) {
          return {
            bind(_workspaceId: string, _deploymentId: string, eventType: string) {
              return {
                async first<T>() {
                  return state.eventTypes.has(eventType) ? ({ '1': 1 } as T) : (null as T);
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_deployments WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind(deploymentId: string) {
              return {
                async first<T>() {
                  if (
                    !state.deploymentExists &&
                    !((options?.reuseRetryScheduled || options?.reuseFailed) && deploymentId === 'dep_existing')
                  ) {
                    return null as T;
                  }
                  return {
                    id: deploymentId,
                    workspace_id: 'ws_abc12345',
                    status: state.deploymentStatus,
                    provider: 'simulated',
                    idempotency_key: 'idem-1',
                    request_payload_json: '{}',
                    request_payload_sha256:
                      options?.reuseRequestPayloadSha256 ??
                      '5c0025e03c59e65566863c1c186a0640fe3c01889fdf396ccd8e65bff4d0feb3',
                    max_retries: 2,
                    attempt_count: options?.reuseRetryScheduled || options?.reuseFailed ? 1 : 0,
                    source_snapshot_sha256: null,
                    source_bundle_key: null,
                    provenance_json: '{}',
                    provider_deployment_id: null,
                    deployed_url: null,
                    last_event_seq: 1,
                    cancel_requested_at: state.cancelRequestedAt,
                    started_at: null,
                    finished_at: null,
                    duration_ms: null,
                    result_json: null,
                    error_code: state.deploymentErrorCode,
                    error_message:
                      state.deploymentErrorCode === 'retry_scheduled'
                        ? 'retry scheduled'
                        : state.deploymentErrorCode === 'provider_auth_failed'
                          ? 'provider auth failed'
                          : null,
                    created_at: '2026-03-08T00:00:00.000Z',
                    updated_at: '2026-03-08T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT seq, event_type, payload_json, created_at/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: [
                      {
                        seq: 1,
                        event_type: 'deployment_created',
                        payload_json: '{"ok":true}',
                        created_at: '2026-03-08T00:00:00.000Z',
                      },
                    ],
                  } as unknown as T;
                },
              };
            },
          };
        }

        if (/UPDATE workspace_deployments\s+SET cancel_requested_at/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  state.cancelRequestedAt = '2026-03-08T00:00:10.000Z';
                  state.deploymentStatus = 'running';
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspace_deployments\s+SET status = 'cancelled'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  state.deploymentStatus = 'cancelled';
                  state.cancelRequestedAt = '2026-03-08T00:00:10.000Z';
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspaces SET/i.test(sql)) {
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

export async function runWorkspaceDeploymentApiTests(): Promise<void> {
  setWorkspaceDeploymentSandboxResolverForTests(async () => ({
    async exec(command: string) {
      if (command.includes('git rev-parse --verify HEAD')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('nimbus_detect_scripts')) {
        return { stdout: JSON.stringify({ hasBuild: false, hasTest: false }), stderr: '', exitCode: 0 };
      }
      if (command.includes('nimbus_detect_toolchain')) {
        return {
          stdout: JSON.stringify({
            packageManager: 'npm@10.8.2',
            scripts: {},
            lockfiles: { pnpm: null, yarn: null, npm: null },
            projectRoot: '.',
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.includes('nimbus_detect_secrets')) {
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      if (command.includes('command -v npm')) {
        return { stdout: '/usr/bin/npm\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  }));

  let waitUntilCalls = 0;
  const ctx = {
    waitUntil() {
      waitUntilCalls += 1;
    },
  } as unknown as ExecutionContext;

  {
    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'simulated' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'cloudflare_workers_assets' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-provider-output-missing' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'provider_invalid_output_dir');
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'simulated' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.deploymentExists, true);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv();
    const longSessionId = `ses_${'x'.repeat(300)}`;
    const longIntentLine = `intent_${'y'.repeat(2000)}`;
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'simulated',
        provenance: {
          sessionIds: [longSessionId],
          intentSessionContext: [longIntentLine],
        },
      }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-provenance-limits' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 202);
    const sessionIds = (state.createdProvenance?.sessionIds ?? []) as string[];
    const intentSessionContext = (state.createdProvenance?.intentSessionContext ?? []) as string[];
    assert.equal(sessionIds.length, 1);
    assert.equal(intentSessionContext.length, 1);
    assert.equal(sessionIds[0].length <= 160, true);
    assert.equal(intentSessionContext[0].length <= 800, true);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv({ reuseRetryScheduled: true });
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'simulated' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 1);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv({ reuseFailed: true });
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 200);
    assert.equal(state.queueSendCount, 0);
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('precheck should not run when claim is blocked');
    }) as typeof fetch;

    try {
      const { env } = createWorkspaceDeploymentApiEnv({ precheckClaimBlockedConcurrentFailed: true });
      const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
        method: 'POST',
        body: JSON.stringify({ provider: 'cloudflare_workers_assets', deploy: { outputDir: 'dist' } }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-precheck-race' },
      });
      const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('precheck should not run for reused deployment');
    }) as typeof fetch;

    try {
      const { env, state } = createWorkspaceDeploymentApiEnv({
        reuseRetryScheduled: true,
        reuseRequestPayloadSha256: 'ce281e4c5ccf595ff5ed74316d66c519a863c09e75128ba9b16de629e9132e31',
      });
      const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
        method: 'POST',
        body: JSON.stringify({ provider: 'cloudflare_workers_assets', deploy: { outputDir: 'dist' } }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
      });
      const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
      assert.equal(response.status, 200);
      assert.equal(state.queueSendCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('precheck should not run for reused deployment');
    }) as typeof fetch;

    try {
      const { env, state } = createWorkspaceDeploymentApiEnv({
        reuseRetryScheduled: true,
        reuseRequestPayloadSha256: 'c01e536525923f382c0594dc7711b1bb1d0a7f05becd9f639ba80e74ddb5d6a7',
      });
      const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'cloudflare_workers_assets',
          deploy: { outputDir: 'dist' },
          provenance: {
            note: 'Use intent context during review',
            sessionIds: ['ses_abc123'],
            transcriptUrl: 'https://example.com/session/ses_abc123',
            intentSessionContext: ['Do not change auth semantics.'],
          },
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
      });
      const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
      assert.equal(response.status, 200);
      assert.equal(state.queueSendCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const { env } = createWorkspaceDeploymentApiEnv({ workspaceStatus: 'deleted' });
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'simulated' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-deleted' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 404);
  }

  {
    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy', {
      method: 'POST',
      body: JSON.stringify({ provider: 'vercel' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-unsupported' },
    });
    const response = await handleCreateWorkspaceDeployment('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv();
    state.deploymentExists = true;
    const response = await handleGetWorkspaceDeployment('ws_abc12345', 'dep_abcd1234', env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy/preflight', {
      method: 'POST',
      body: JSON.stringify({ validation: { runBuildIfPresent: true, runTestsIfPresent: true } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleWorkspaceDeploymentPreflight('ws_abc12345', request, env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy/preflight', {
      method: 'POST',
      body: JSON.stringify({ provider: 'cloudflare_workers_assets' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleWorkspaceDeploymentPreflight('ws_abc12345', request, env as never);
    const body = (await response.json()) as {
      preflight: { ok: boolean; checks: Array<{ code: string; ok: boolean }> };
    };
    assert.equal(response.status, 200);
    assert.equal(body.preflight.ok, false);
    assert.equal(body.preflight.checks.some((check) => check.code === 'provider_invalid_output_dir' && !check.ok), true);
  }

  {
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: 'fatal: needed a single revision', exitCode: 1 };
        }
        if (command.includes('git init -q')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'npm@10.8.2',
              scripts: {},
              lockfiles: { pnpm: null, yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    const { env } = createWorkspaceDeploymentApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy/preflight', {
      method: 'POST',
      body: JSON.stringify({ autoFix: { rehydrateBaseline: true } }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleWorkspaceDeploymentPreflight('ws_abc12345', request, env as never);
    const body = (await response.json()) as {
      preflight: { ok: boolean; remediations: Array<{ code: string; applied: boolean }> };
    };
    assert.equal(response.status, 200);
    assert.equal(body.preflight.ok, true);
    assert.equal(body.preflight.remediations.some((item) => item.code === 'baseline_rehydrated' && item.applied), true);

    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: false }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'npm@10.8.2',
              scripts: {},
              lockfiles: { pnpm: null, yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('command -v npm')) {
          return { stdout: '/usr/bin/npm\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));
  }

  {
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    const { env } = createWorkspaceDeploymentApiEnv({ sourceProjectRoot: '../outside' });
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deploy/preflight', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleWorkspaceDeploymentPreflight('ws_abc12345', request, env as never);
    const body = (await response.json()) as {
      preflight: { ok: boolean; checks: Array<{ code: string; ok: boolean }> };
      nextAction: string | null;
    };
    assert.equal(response.status, 200);
    assert.equal(body.preflight.ok, false);
    assert.equal(body.preflight.checks.some((check) => check.code === 'project_root' && !check.ok), true);
    assert.equal(
      body.nextAction,
      'Set workspace source project root to a safe relative path and retry preflight.'
    );
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv({ workspaceStatus: 'deleted' });
    state.deploymentExists = true;
    const response = await handleGetWorkspaceDeployment('ws_abc12345', 'dep_abcd1234', env as never);
    assert.equal(response.status, 404);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv();
    state.deploymentExists = true;
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deployments/dep_abcd1234/events?from=0');
    const response = await handleGetWorkspaceDeploymentEvents('ws_abc12345', 'dep_abcd1234', request, env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv({ workspaceStatus: 'deleted' });
    state.deploymentExists = true;
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/deployments/dep_abcd1234/events?from=0');
    const response = await handleGetWorkspaceDeploymentEvents('ws_abc12345', 'dep_abcd1234', request, env as never);
    assert.equal(response.status, 404);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv();
    state.deploymentExists = true;
    const response = await handleCancelWorkspaceDeployment('ws_abc12345', 'dep_abcd1234', env as never);
    assert.equal(response.status, 202);
  }

  {
    waitUntilCalls = 0;
    const { env, state } = createWorkspaceDeploymentApiEnv();
    delete (env as { WORKSPACE_DEPLOYS_QUEUE?: unknown }).WORKSPACE_DEPLOYS_QUEUE;
    state.deploymentExists = true;
    state.deploymentStatus = 'running';
    const response = await handleCancelWorkspaceDeployment('ws_abc12345', 'dep_abcd1234', env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(waitUntilCalls, 1);
  }

  {
    const { env, state } = createWorkspaceDeploymentApiEnv({ workspaceStatus: 'deleted' });
    state.deploymentExists = true;
    const response = await handleCancelWorkspaceDeployment('ws_abc12345', 'dep_abcd1234', env as never);
    assert.equal(response.status, 404);
  }

  setWorkspaceDeploymentSandboxResolverForTests(null);
}
