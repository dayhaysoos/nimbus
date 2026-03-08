import { strict as assert } from 'assert';
import {
  processWorkspaceTask,
  setWorkspaceTaskSandboxResolverForTests,
  shouldRetryWorkspaceTaskError,
} from './workspace-task-runner.js';

function createRunnerEnv(): {
  env: Record<string, unknown>;
  state: {
    status: string;
    attemptCount: number;
    events: Array<{ eventType: string; payload: unknown }>;
    fileContent: string;
  };
} {
  const state = {
    status: 'queued',
    attemptCount: 0,
    events: [] as Array<{ eventType: string; payload: unknown }>,
    fileContent: '',
  };

  const taskPayload = {
    prompt: 'Update README',
    provider: 'scripted',
    model: 'test-model',
    maxSteps: 5,
    maxRetries: 1,
    scriptedActions: [
      { type: 'tool', tool: 'write_file', args: { path: 'README.md', content: 'hello world\n' } },
      { type: 'final', summary: 'done' },
    ],
  };

  const env = {
    WORKSPACE_AGENT_RUNTIME_ENABLED: 'true',
    WORKSPACE_AGENT_ALLOW_SCRIPTED_PROVIDER: 'true',
    DB: {
      prepare(sql: string) {
        if (/SELECT key, value FROM runtime_flags/i.test(sql)) {
          return {
            async all<T>() {
              return { results: [] as unknown as T[] };
            },
          };
        }

        if (/UPDATE workspace_tasks\s+SET status = 'running'/i.test(sql)) {
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

        if (/SELECT \* FROM workspace_tasks WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'task_abcd1234',
                    workspace_id: 'ws_abc12345',
                    status: state.status,
                    prompt: 'Update README',
                    provider: 'scripted',
                    model: 'test-model',
                    idempotency_key: 'idem-1',
                    request_payload_json: JSON.stringify(taskPayload),
                    request_payload_sha256: 'hash',
                    max_steps: 5,
                    max_retries: 1,
                    attempt_count: state.attemptCount,
                    actor_id: null,
                    tool_policy_json: '{}',
                    started_at: null,
                    finished_at: null,
                    cancel_requested_at: null,
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

        if (/SELECT request_payload_json FROM workspace_tasks WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    request_payload_json: JSON.stringify(taskPayload),
                  } as T;
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

        if (/UPDATE workspace_tasks SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

        if (/INSERT INTO workspace_task_events/i.test(sql)) {
          return {
            bind(_workspaceId: string, _taskId: string, _seq: number, eventType: string, payloadJson: string) {
              return {
                async run() {
                  state.events.push({ eventType, payload: JSON.parse(payloadJson) });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspace_tasks SET/i.test(sql)) {
          return {
            bind(status: string) {
              return {
                async run() {
                  state.status = status;
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
    Sandbox: {
      idFromName() {
        return {};
      },
    },
  };

  return { env, state };
}

export async function runWorkspaceTaskRunnerTests(): Promise<void> {
  {
    const { env, state } = createRunnerEnv();
    setWorkspaceTaskSandboxResolverForTests(async () => ({
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile(_path: string, contents: string) {
        state.fileContent = contents;
        return {};
      },
    }));

    await processWorkspaceTask(env as never, 'ws_abc12345', 'task_abcd1234');
    assert.equal(state.status, 'succeeded');
    assert.equal(state.fileContent, 'hello world\n');
    assert.equal(state.events.some((event) => event.eventType === 'task_succeeded'), true);
  }

  {
    const retry = shouldRetryWorkspaceTaskError(new Error('x'));
    assert.equal(retry, false);
  }

  setWorkspaceTaskSandboxResolverForTests(null);
}
