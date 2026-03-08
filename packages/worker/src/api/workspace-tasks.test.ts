import { strict as assert } from 'assert';
import {
  handleCancelWorkspaceTask,
  handleCreateWorkspaceTask,
  handleGetWorkspaceTask,
  handleGetWorkspaceTaskEvents,
} from './workspace-tasks.js';

function createWorkspaceTaskApiEnv(): { env: Record<string, unknown>; state: { taskExists: boolean } } {
  const state = {
    taskExists: false,
  };

  const env = {
    WORKSPACE_AGENT_RUNTIME_ENABLED: 'true',
    WORKSPACE_AGENT_ALLOW_SCRIPTED_PROVIDER: 'true',
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

        if (/SELECT task_id, request_payload_sha256, expires_at/i.test(sql)) {
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

        if (/INSERT INTO workspace_tasks/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  state.taskExists = true;
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    status: 'queued',
                    prompt: values[2],
                    provider: values[3],
                    model: values[4],
                    idempotency_key: values[5],
                    request_payload_json: values[6],
                    request_payload_sha256: values[7],
                    max_steps: values[8],
                    max_retries: values[9],
                    attempt_count: 0,
                    actor_id: null,
                    tool_policy_json: values[11],
                    last_event_seq: 0,
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

        if (/INSERT INTO workspace_task_idempotency/i.test(sql)) {
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

        if (/UPDATE workspace_tasks SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

        if (/INSERT INTO workspace_task_events/i.test(sql)) {
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

        if (/SELECT \* FROM workspace_tasks WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind(taskId: string) {
              return {
                async first<T>() {
                  if (!state.taskExists) {
                    return null as T;
                  }
                  return {
                    id: taskId,
                    workspace_id: 'ws_abc12345',
                    status: 'queued',
                    prompt: 'Do a thing',
                    provider: 'scripted',
                    model: 'test',
                    idempotency_key: 'idem-1',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    max_steps: 8,
                    max_retries: 2,
                    attempt_count: 0,
                    actor_id: null,
                    tool_policy_json: '{}',
                    last_event_seq: 1,
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

        if (/SELECT seq, event_type, payload_json, created_at/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: [
                      {
                        seq: 1,
                        event_type: 'task_created',
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

        if (/UPDATE workspace_tasks\s+SET cancel_requested_at/i.test(sql)) {
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
    Sandbox: {
      idFromName() {
        return {};
      },
    },
  };

  return { env, state };
}

export async function runWorkspaceTaskApiTests(): Promise<void> {
  const ctx = {
    waitUntil() {
      // no-op for tests
    },
  } as unknown as ExecutionContext;

  {
    const { env } = createWorkspaceTaskApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Do a thing' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleCreateWorkspaceTask('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 400);
  }

  {
    const { env } = createWorkspaceTaskApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Do a thing' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-x' },
    });
    const response = await handleCreateWorkspaceTask('ws_abc12345', request, env as never);
    assert.equal(response.status, 503);
  }

  {
    const { env, state } = createWorkspaceTaskApiEnv();
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Do a thing', provider: 'scripted' }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    });
    const response = await handleCreateWorkspaceTask('ws_abc12345', request, env as never, ctx);
    assert.equal(response.status, 202);
    assert.equal(state.taskExists, true);
  }

  {
    const { env, state } = createWorkspaceTaskApiEnv();
    state.taskExists = true;
    const response = await handleGetWorkspaceTask('ws_abc12345', 'task_abcd1234', env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env, state } = createWorkspaceTaskApiEnv();
    state.taskExists = true;
    const request = new Request('https://example.com/api/workspaces/ws_abc12345/tasks/task_abcd1234/events?from=0');
    const response = await handleGetWorkspaceTaskEvents('ws_abc12345', 'task_abcd1234', request, env as never);
    assert.equal(response.status, 200);
  }

  {
    const { env, state } = createWorkspaceTaskApiEnv();
    state.taskExists = true;
    const response = await handleCancelWorkspaceTask('ws_abc12345', 'task_abcd1234', env as never);
    assert.equal(response.status, 202);
  }
}
