import { strict as assert } from 'assert';
import {
  processWorkspaceDeployment,
  runWorkspaceDeploymentInlineWithRetries,
  setWorkspaceDeploymentSandboxResolverForTests,
  shouldRetryWorkspaceDeploymentError,
} from './workspace-deployment-runner.js';

function createDeploymentRunnerEnv(options?: {
  failWorkspaceSummaryUpdate?: boolean;
  failWorkspaceSummaryUpdateTimes?: number;
  failRollbackLookup?: boolean;
  failSucceededEventInsertOnce?: boolean;
  failClaimOnce?: boolean;
  succeedUpdateBlockedByCancel?: boolean;
  requestRunTestsIfPresent?: boolean;
  requestRunBuildIfPresent?: boolean;
  initialStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  initialStartedAt?: string | null;
  initialCancelRequestedAt?: string | null;
}): {
  env: Record<string, unknown>;
  state: {
    status: string;
    attemptCount: number;
    events: Array<{ eventType: string; payload: unknown }>;
    deployedUrl: string | null;
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
    cancelRequestedAt: options?.initialCancelRequestedAt ?? null,
    startedAt: options?.initialStartedAt ?? null,
    workspaceSummaryUpdateCalls: 0,
    workspaceSummaryLastStatus: null as string | null,
  };

  const deploymentPayload = {
    provider: 'simulated',
    validation: {
      runBuildIfPresent: options?.requestRunBuildIfPresent ?? false,
      runTestsIfPresent: options?.requestRunTestsIfPresent ?? false,
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

  const env = {
    WORKSPACE_DEPLOY_ENABLED: 'true',
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
                    provider_deployment_id: null,
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
                    source_project_root: '.',
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
            bind(
              _sourceSnapshotSha256: string,
              _sourceBundleKey: string,
              deployedUrl: string
            ) {
              return {
                async run() {
                  succeededUpdateAttempts += 1;
                  if (options?.succeedUpdateBlockedByCancel && succeededUpdateAttempts === 1) {
                    state.cancelRequestedAt = '2026-03-08T00:00:05.000Z';
                    return { success: true, meta: { changes: 0 } };
                  }
                  state.status = 'succeeded';
                  state.deployedUrl = deployedUrl;
                  return { success: true, meta: { changes: 1 } };
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
    assert.equal(state.events.some((event) => event.eventType === 'deployment_cancelled'), true);
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
    const { env, state } = createDeploymentRunnerEnv({ failWorkspaceSummaryUpdate: true });
    setWorkspaceDeploymentSandboxResolverForTests(async () => ({
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('nimbus_detect_scripts')) {
          return { stdout: JSON.stringify({ hasBuild: false, hasTest: false }), stderr: '', exitCode: 0 };
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
        if (command.includes('nimbus_detect_secrets')) {
          return { stdout: '[]', stderr: '', exitCode: 0 };
        }
        if (command.includes('npm run -s test')) {
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
    assert.equal(state.status, 'cancelled');
  }

  setWorkspaceDeploymentSandboxResolverForTests(null);
}
