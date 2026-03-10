import { strict as assert } from 'assert';
import {
  processWorkspaceDeployment,
  runWorkspaceDeploymentInlineWithRetries,
  setWorkspaceDeploymentSandboxResolverForTests,
  shouldRetryWorkspaceDeploymentError,
} from './workspace-deployment-runner.js';
import { setWorkspaceDeployProviderFetchForTests } from './workspace-deploy-provider.js';

function createDeploymentRunnerEnv(options?: {
  failWorkspaceSummaryUpdate?: boolean;
  failWorkspaceSummaryUpdateTimes?: number;
  failRollbackLookup?: boolean;
  failSucceededEventInsertOnce?: boolean;
  failClaimOnce?: boolean;
  succeedUpdateBlockedByCancel?: boolean;
  inlineRecoverCancelRace?: boolean;
  requestRunTestsIfPresent?: boolean;
  requestRunBuildIfPresent?: boolean;
  requestAutoFixRehydrateBaseline?: boolean;
  requestAutoFixBootstrapToolchain?: boolean;
  requestProvider?: 'simulated' | 'cloudflare_workers_assets';
  requestOutputDir?: string | null;
  sourceProjectRoot?: string;
  initialStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  initialStartedAt?: string | null;
  initialCancelRequestedAt?: string | null;
  initialProviderDeploymentId?: string | null;
  dependencyCacheArtifactKey?: string;
}): {
  env: Record<string, unknown>;
  state: {
    status: string;
    attemptCount: number;
    events: Array<{ eventType: string; payload: unknown }>;
    deployedUrl: string | null;
    providerDeploymentId: string | null;
    cancelRequestedAt: string | null;
    startedAt: string | null;
    workspaceSummaryUpdateCalls: number;
    workspaceSummaryLastStatus: string | null;
  };
} {
  const state = {
    status: options?.initialStatus ?? 'queued',
    attemptCount: 0,
    events: [] as Array<{ eventType: string; payload: unknown }>,
    deployedUrl: null as string | null,
    providerDeploymentId: options?.initialProviderDeploymentId ?? null,
    cancelRequestedAt: options?.initialCancelRequestedAt ?? null,
    startedAt: options?.initialStartedAt ?? null,
    workspaceSummaryUpdateCalls: 0,
    workspaceSummaryLastStatus: null as string | null,
  };

  const deploymentPayload = {
    provider: options?.requestProvider ?? 'simulated',
    validation: {
      runBuildIfPresent: options?.requestRunBuildIfPresent ?? false,
      runTestsIfPresent: options?.requestRunTestsIfPresent ?? false,
    },
    autoFix: {
      rehydrateBaseline: options?.requestAutoFixRehydrateBaseline ?? false,
      bootstrapToolchain: options?.requestAutoFixBootstrapToolchain ?? false,
    },
    deploy: {
      outputDir: options?.requestOutputDir ?? null,
    },
    rollbackOnFailure: true,
    provenance: {
      trigger: 'manual',
      taskId: null,
      operationId: null,
      note: null,
    },
  };
  let failedSucceededEventInsert = false;
  let claimAttempts = 0;
  let succeededUpdateAttempts = 0;
  let inlineRecoverRaceInjected = false;

  const env = {
    WORKSPACE_DEPLOY_ENABLED: 'true',
    WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
    WORKSPACE_DEPLOY_PROJECT_NAME: 'nimbus',
    WORKSPACE_DEPLOY_PROVIDER_MAX_POLLS: '2',
    WORKSPACE_DEPLOY_PROVIDER_POLL_INTERVAL_MS: '1',
    CF_ACCOUNT_ID: 'acc',
    CF_API_TOKEN: 'token',
    DB: {
      prepare(sql: string) {
        if (/SELECT key, value FROM runtime_flags/i.test(sql)) {
          return {
            async all<T>() {
              return { results: [] as unknown as T[] };
            },
          };
        }

        if (/UPDATE workspace_deployments\s+SET status = 'running'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  claimAttempts += 1;
                  if (options?.failClaimOnce && claimAttempts === 1) {
                    throw new Error('database is locked');
                  }
                  if (state.status !== 'queued') {
                    return { success: true, meta: { changes: 0 } };
                  }
                  state.status = 'running';
                  state.attemptCount += 1;
                  if (!state.startedAt) {
                    state.startedAt = '2026-03-08T00:00:00.000Z';
                  }
                  return { success: true, meta: { changes: 1 } };
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
                    status: state.status,
                    provider: 'simulated',
                    idempotency_key: 'idem-1',
                    request_payload_json: JSON.stringify(deploymentPayload),
                    request_payload_sha256: 'hash',
                    max_retries: 1,
                    attempt_count: state.attemptCount,
                    source_snapshot_sha256: null,
                    source_bundle_key: null,
                    provenance_json: JSON.stringify(deploymentPayload.provenance),
                    provider_deployment_id: state.providerDeploymentId,
                    deployed_url: state.deployedUrl,
                    last_event_seq: 0,
                    cancel_requested_at: state.cancelRequestedAt,
                    started_at: state.startedAt,
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

        if (/SELECT request_payload_json FROM workspace_deployments WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    request_payload_json: JSON.stringify(deploymentPayload),
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT \*\s+FROM workspace_deployments\s+WHERE workspace_id = \? AND status = 'succeeded'/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.failRollbackLookup) {
                    throw new Error('database is locked');
                  }
                  return null as T;
                },
              };
            },
          };
        }

        if (/FROM workspace_dependency_caches\s+WHERE workspace_id = \? AND cache_key = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (!options?.dependencyCacheArtifactKey) {
                    return null as T;
                  }
                  return {
                    id: 'wdc_abc',
                    workspace_id: 'ws_abc12345',
                    cache_key: 'cache-key',
                    manager: 'npm',
                    manager_version: null,
                    project_root: '.',
                    lockfile_name: null,
                    lockfile_sha256: null,
                    artifact_key: options.dependencyCacheArtifactKey,
                    artifact_sha256: 'f'.repeat(64),
                    artifact_bytes: 3,
                    last_used_at: '2026-03-08T00:00:00.000Z',
                    created_at: '2026-03-08T00:00:00.000Z',
                    updated_at: '2026-03-08T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/UPDATE workspace_dependency_caches\s+SET last_used_at/i.test(sql)) {
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

        if (/INSERT INTO workspace_dependency_caches/i.test(sql)) {
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

        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_abc12345',
                    status: 'ready',
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

        if (/UPDATE workspace_deployments SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

        if (/INSERT INTO workspace_deployment_events/i.test(sql)) {
          return {
            bind(_workspaceId: string, _deploymentId: string, _seq: number, eventType: string, payloadJson: string) {
              return {
                async run() {
                  if (
                    options?.failSucceededEventInsertOnce &&
                    eventType === 'deployment_succeeded' &&
                    !failedSucceededEventInsert
                  ) {
                    failedSucceededEventInsert = true;
                    throw new Error('database is locked');
                  }
                  state.events.push({ eventType, payload: JSON.parse(payloadJson) });
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
                  return (state.events.some((event) => event.eventType === eventType)
                    ? ({ '1': 1 } as unknown as T)
                    : (null as T));
                },
              };
            },
          };
        }

        if (/UPDATE\s+workspace_deployments\s+SET\s+status\s*=\s*'succeeded'/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  succeededUpdateAttempts += 1;
                  if (options?.succeedUpdateBlockedByCancel && succeededUpdateAttempts === 1) {
                    state.cancelRequestedAt = '2026-03-08T00:00:05.000Z';
                    return { success: true, meta: { changes: 0 } };
                  }
                  state.status = 'succeeded';
                  for (const value of values) {
                    if (typeof value === 'string' && value.startsWith('https://')) {
                      state.deployedUrl = value;
                    }
                    if (typeof value === 'string' && value.startsWith('cfdep_')) {
                      state.providerDeploymentId = value;
                    }
                  }
                  if (/cancel_requested_at\s*=\s*NULL/i.test(sql)) {
                    state.cancelRequestedAt = null;
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE\s+workspace_deployments\s+SET\s+status\s*=\s*'failed'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  state.status = 'failed';
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (
          /UPDATE\s+workspace_deployments\s+SET\s+status\s*=\s*'queued'/i.test(sql) &&
          /cancel_requested_at\s+IS\s+NULL/i.test(sql)
        ) {
          return {
            bind() {
              return {
                async run() {
                  if (options?.inlineRecoverCancelRace && !inlineRecoverRaceInjected) {
                    inlineRecoverRaceInjected = true;
                    state.cancelRequestedAt = '2026-03-08T00:00:07.000Z';
                  }
                  if (state.status === 'running' && state.cancelRequestedAt === null) {
                    state.status = 'queued';
                    state.startedAt = null;
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspace_deployments SET/i.test(sql)) {
          return {
            bind(status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', ...values: unknown[]) {
              return {
                async run() {
                  state.status = status;
                  if (status === 'queued') {
                    state.startedAt = null;
                  }
                  if (/cancel_requested_at\s*=\s*\?/i.test(sql) && status === 'succeeded') {
                    state.cancelRequestedAt = null;
                  }
                  for (const value of values) {
                    if (typeof value === 'string' && value.startsWith('https://')) {
                      state.deployedUrl = value;
                    }
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE\s+workspaces\s+SET/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  state.workspaceSummaryUpdateCalls += 1;
                  if (typeof values[1] === 'string') {
                    state.workspaceSummaryLastStatus = values[1];
                  }
                  if (options?.failWorkspaceSummaryUpdate && state.workspaceSummaryUpdateCalls === 1) {
                    throw new Error('database is locked');
                  }
                  if (
                    typeof options?.failWorkspaceSummaryUpdateTimes === 'number' &&
                    state.workspaceSummaryUpdateCalls <= options.failWorkspaceSummaryUpdateTimes
                  ) {
                    throw new Error('database is locked');
                  }
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
                  state.status = 'cancelled';
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
    WORKSPACE_ARTIFACTS: {
      async put() {
        return;
      },
      async get(key: string) {
        if (options?.dependencyCacheArtifactKey && key === options.dependencyCacheArtifactKey) {
          return {
            async arrayBuffer() {
              return new Uint8Array([1, 2, 3]).buffer;
            },
          };
        }
        return null;
      },
    },
    Sandbox: {
      idFromName() {
        return {};
      },
    },
  };

  return { env, state };
}

export async function runWorkspaceDeploymentRunnerTests(): Promise<void> {
  {
    const { env, state } = createDeploymentRunnerEnv({ requestRunTestsIfPresent: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(Boolean(state.deployedUrl), true);
    assert.equal(state.events.some((event) => event.eventType === 'deployment_succeeded'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ requestRunTestsIfPresent: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          state.cancelRequestedAt = '2026-03-08T00:00:02.000Z';
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'cancelled');
  }

  {
    const retry = shouldRetryWorkspaceDeploymentError(new Error('network timeout'));
    assert.equal(retry, true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ requestRunTestsIfPresent: true });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        throw new Error('database is locked');
      },
    }));

    await assert.rejects(
      processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234'),
      /retry requested/
    );
    assert.equal(state.status, 'queued');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      requestRunTestsIfPresent: true,
      inlineRecoverCancelRace: true,
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        throw new Error('database is locked');
      },
    }));

    await runWorkspaceDeploymentInlineWithRetries(env as never, 'ws_abc12345', 'dep_abcd1234', 1);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_retry_scheduled'), false);
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancelled'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ failWorkspaceSummaryUpdate: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.workspaceSummaryUpdateCalls, 2);
    assert.equal(state.workspaceSummaryLastStatus, 'succeeded');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ failWorkspaceSummaryUpdateTimes: 2 });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await assert.rejects(
      processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234'),
      /reconciliation failed; retry requested/
    );
    assert.equal(state.status, 'succeeded');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'succeeded',
      failWorkspaceSummaryUpdateTimes: 1,
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await assert.rejects(
      processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234'),
      /reconciliation failed; retry requested/
    );
    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.workspaceSummaryUpdateCalls >= 2, true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ failSucceededEventInsertOnce: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_succeeded'), true);
    assert.equal(state.workspaceSummaryLastStatus, 'succeeded');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ failRollbackLookup: true });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: 'fatal: needed a single revision', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: '2020-01-01T00:00:00.000Z',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_failed'), true);
    assert.equal(state.workspaceSummaryLastStatus, 'failed');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: '2020-01-01T00:00:00.000Z',
      initialCancelRequestedAt: '2026-03-08T00:00:00.000Z',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(
      state.events.some(
        (event) =>
          event.eventType === 'deployment_failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { code?: string }).code === 'deployment_stale_timeout_cancel_pending'
      ),
      true
    );
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: new Date().toISOString(),
      initialCancelRequestedAt: '2026-03-08T00:00:00.000Z',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'cancelled');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancelled'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: new Date().toISOString(),
      initialCancelRequestedAt: '2026-03-08T00:00:00.000Z',
      initialProviderDeploymentId: 'cfdep_dep_abcd1234',
      requestProvider: 'cloudflare_workers_assets',
      requestOutputDir: 'dist',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));
    setWorkspaceDeployProviderFetchForTests(async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/nimbus/deployments/cfdep_dep_abcd1234')) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'forbidden' }] }), { status: 403 });
      }
      throw new Error(`Unexpected provider URL in cancel-reconcile failure test: ${url}`);
    });

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(
      state.events.some(
        (event) =>
          event.eventType === 'deployment_failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { code?: string }).code === 'provider_scope_missing'
      ),
      true
    );
    setWorkspaceDeployProviderFetchForTests(null);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'queued',
      initialCancelRequestedAt: '2026-03-08T00:00:00.000Z',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'cancelled');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancelled'), true);
    assert.equal(state.workspaceSummaryLastStatus, 'cancelled');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: new Date().toISOString(),
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await runWorkspaceDeploymentInlineWithRetries(env as never, 'ws_abc12345', 'dep_abcd1234', 1);
    assert.equal(state.status, 'running');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_retry_scheduled'), false);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ failClaimOnce: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await runWorkspaceDeploymentInlineWithRetries(env as never, 'ws_abc12345', 'dep_abcd1234', 3);
    assert.equal(state.status, 'succeeded');
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ requestRunTestsIfPresent: true });
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
          return { stdout: JSON.stringify(['.env']), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_failed'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ requestRunTestsIfPresent: true });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: true }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'pnpm@9.15.0',
              scripts: {},
              lockfiles: { pnpm: 'abc', yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('pnpm run -s test')) {
          return { stdout: '', stderr: 'sh: 1: pnpm: not found', exitCode: 127 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(
      state.events.some(
        (event) =>
          event.eventType === 'deployment_failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { code?: string }).code === 'validation_tool_missing'
      ),
      true
    );
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      initialStatus: 'running',
      initialStartedAt: new Date().toISOString(),
      initialCancelRequestedAt: '2026-03-08T00:00:00.000Z',
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await runWorkspaceDeploymentInlineWithRetries(env as never, 'ws_abc12345', 'dep_abcd1234', 1);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancelled'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ succeedUpdateBlockedByCancel: true });
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
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.cancelRequestedAt, null);
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancel_rejected'), true);
  }

  {
    const commands: string[] = [];
    const { env, state } = createDeploymentRunnerEnv({
      requestRunTestsIfPresent: true,
      requestRunBuildIfPresent: true,
      requestAutoFixBootstrapToolchain: true,
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        commands.push(command);
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: true, hasTest: true }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'pnpm@9.15.0',
              scripts: {},
              lockfiles: { pnpm: 'abc', yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('corepack --version')) {
          return { stdout: '0.29.0', stderr: '', exitCode: 0 };
        }
        if (command.includes('corepack enable')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('corepack prepare pnpm@9.15.0 --activate')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('pnpm run -s test') || command.includes('pnpm run -s build')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(commands.some((command) => command.includes('corepack prepare pnpm@9.15.0 --activate')), true);
    assert.equal(commands.some((command) => command.includes('pnpm run -s test')), true);
    assert.equal(commands.some((command) => command.includes('pnpm run -s build')), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      requestRunTestsIfPresent: true,
      requestAutoFixBootstrapToolchain: true,
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: true }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'pnpm@9.15.0',
              scripts: {},
              lockfiles: { pnpm: 'abc', yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('corepack --version')) {
          return { stdout: '', stderr: 'corepack: command not found', exitCode: 127 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(
      state.events.some(
        (event) =>
          event.eventType === 'deployment_failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { code?: string }).code === 'corepack_missing'
      ),
      true
    );
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ dependencyCacheArtifactKey: 'cache-key-artifact' });
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
              lockfiles: { pnpm: null, yarn: null, npm: 'abc' },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes("tar -xzf - -C")) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.events.some((event) => event.eventType === 'deployment_dependency_cache_hit'), true);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      requestRunTestsIfPresent: false,
      requestRunBuildIfPresent: false,
      requestAutoFixBootstrapToolchain: true,
    });
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
              packageManager: 'pnpm@9.15.0',
              scripts: {},
              lockfiles: { pnpm: 'abc', yarn: null, npm: null },
              projectRoot: '.',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('corepack --version')) {
          return { stdout: '', stderr: 'corepack: command not found', exitCode: 127 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
  }

  {
    const commands: string[] = [];
    const { env, state } = createDeploymentRunnerEnv({
      sourceProjectRoot: 'apps/web',
      requestRunTestsIfPresent: true,
    });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        commands.push(command);
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: true }), stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_toolchain')) {
          return {
            stdout: JSON.stringify({
              packageManager: 'npm@10.8.2',
              scripts: {},
              lockfiles: { pnpm: null, yarn: null, npm: null },
              projectRoot: 'apps/web',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('npm run -s test')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(
      commands.some((command) => command.includes("cd '/workspace/apps/web' && npm run -s test")),
      true
    );
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      requestProvider: 'cloudflare_workers_assets',
      requestOutputDir: 'dist',
    });
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
        if (command.includes('nimbus-workspace-output')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    setWorkspaceDeployProviderFetchForTests(async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/nimbus')) {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['039058c6f2c0cb492c533b0a4d14ef77']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_dep_abcd1234' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments/cfdep_dep_abcd1234')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'running' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL in timeout test: ${url}`);
    });

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    setWorkspaceDeployProviderFetchForTests(null);
  }

  {
    let deploymentBody: Record<string, unknown> | null = null;
    const { env, state } = createDeploymentRunnerEnv({
      requestProvider: 'cloudflare_workers_assets',
      requestOutputDir: 'dist',
      sourceProjectRoot: 'apps/web',
    });
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
              projectRoot: 'apps/web',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    setWorkspaceDeployProviderFetchForTests(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/nimbus')) {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['039058c6f2c0cb492c533b0a4d14ef77']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments')) {
        deploymentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_dep_abcd1234' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments/cfdep_dep_abcd1234')) {
        return new Response(
          JSON.stringify({ success: true, result: { status: 'succeeded', preview_url: 'https://dep-dep-abcd1234.preview.example.com' } }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected provider URL in monorepo output_dir test: ${url}`);
    });

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(deploymentBody?.['output_dir'], 'dist');
    setWorkspaceDeployProviderFetchForTests(null);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({
      requestProvider: 'cloudflare_workers_assets',
      requestOutputDir: 'dist',
    });
    let statusReads = 0;
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
        if (command.includes('nimbus-workspace-output')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        if (command.includes('base64 "$tmp_bundle"')) {
          return { stdout: 'AQID', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    setWorkspaceDeployProviderFetchForTests(async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/nimbus')) {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['039058c6f2c0cb492c533b0a4d14ef77']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_dep_abcd1234' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments/cfdep_dep_abcd1234/cancel')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'cannot cancel' }] }), {
          status: 409,
        });
      }
      if (url.endsWith('/workers/scripts/nimbus/deployments/cfdep_dep_abcd1234')) {
        statusReads += 1;
        if (statusReads < 2) {
          state.cancelRequestedAt = '2026-03-08T00:00:02.000Z';
          return new Response(JSON.stringify({ success: true, result: { status: 'running' } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: { status: 'succeeded', preview_url: 'https://dep-dep_abcd1234.preview.example.com' },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected provider URL in cancel continuation test: ${url}`);
    });

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'succeeded');
    setWorkspaceDeployProviderFetchForTests(null);
  }

  {
    const { env, state } = createDeploymentRunnerEnv({ sourceProjectRoot: '../outside' });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    await processWorkspaceDeployment(env as never, 'ws_abc12345', 'dep_abcd1234');
    assert.equal(state.status, 'failed');
    assert.equal(
      state.events.some(
        (event) =>
          event.eventType === 'deployment_failed' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          (event.payload as { code?: string }).code === 'invalid_project_root'
      ),
      true
    );
  }

  setWorkspaceDeploymentSandboxResolverForTests(null);
  setWorkspaceDeployProviderFetchForTests(null);
}
