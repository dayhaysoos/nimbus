import { strict as assert } from 'assert';
import { handleGetWorkspace } from './api/workspaces.js';
import { authenticateRequest } from './lib/auth.js';
import type { AuthContext } from './types.js';

interface PreparedStatement {
  bind: (...values: unknown[]) => {
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  };
}

function createWorkerTestEnv(options?: {
  hosted?: boolean;
  keyHash?: string;
  workspaceExists?: boolean;
  jobExists?: boolean;
}) {
  const env = {
    NIMBUS_HOSTED: options?.hosted ? 'true' : 'false',
    DB: {
      prepare(sql: string): PreparedStatement {
        if (sql.includes('FROM nimbus_api_keys WHERE key_hash = ?')) {
          return {
            bind(keyHash: unknown) {
              return {
                async first<T>() {
                  if (typeof keyHash === 'string' && keyHash === options?.keyHash) {
                    return {
                      account_id: 'acct_123',
                      is_admin: 0,
                    } as T;
                  }
                  return null;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (sql.includes('UPDATE nimbus_api_keys SET last_used_at = ? WHERE key_hash = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (sql.includes('SELECT * FROM workspaces WHERE id = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.workspaceExists === false) {
                    return null;
                  }
                  return {
                    id: 'ws_abc12345',
                    status: 'ready',
                    source_type: 'checkpoint',
                    checkpoint_id: null,
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'workspaces/ws_abc12345/source.tar.gz',
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
                    created_at: '2026-03-15T00:00:00.000Z',
                    updated_at: '2026-03-15T00:00:00.000Z',
                    deleted_at: null,
                  } as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (sql.includes('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
                async all<T>() {
                  if (options?.jobExists === false) {
                    return { results: [] as T[] };
                  }
                  return {
                    results: [
                      {
                        id: 'job_abc12345',
                        prompt: 'build',
                        model: 'claude',
                        status: 'queued',
                        phase: 'queued',
                        created_at: '2026-03-15T00:00:00.000Z',
                        started_at: null,
                        completed_at: null,
                        preview_url: null,
                        deployed_url: null,
                        error_message: null,
                        file_count: null,
                      },
                    ] as T[],
                  };
                },
                async run() {
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (sql.includes('SELECT * FROM jobs WHERE id = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.jobExists === false) {
                    return null;
                  }
                  return {
                    id: 'job_abc12345',
                    prompt: 'build',
                    model: 'claude',
                    status: 'queued',
                    phase: 'queued',
                    created_at: '2026-03-15T00:00:00.000Z',
                    started_at: null,
                    completed_at: null,
                    preview_url: null,
                    deployed_url: null,
                    error_message: null,
                    file_count: null,
                  } as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (sql.includes('FROM job_events')) {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
                async all<T>() {
                  return { results: [] as T[] };
                },
                async run() {
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first<T>() {
                return null as T;
              },
              async all<T>() {
                return { results: [] as T[] };
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };

  return env;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function runAuthMiddlewareTests(): Promise<void> {
  const validKey = 'nmb_live_valid123';
  const validKeyHash = await sha256Hex(validKey);

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const result = await authenticateRequest(new Request('https://example.com/api/workspaces/ws_abc12345'), env as never);
    assert.equal('response' in result, true);
    const response = (result as { response: Response }).response;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'API key required', code: 'unauthorized' });
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const result = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': 'nmb_live_invalid' },
      }),
      env as never
    );
    assert.equal('response' in result, true);
    const response = (result as { response: Response }).response;
    assert.equal(response.status, 401);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': validKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 200);
  }

  {
    const env = createWorkerTestEnv({ hosted: false });
    const authResult = await authenticateRequest(new Request('https://example.com/api/workspaces/ws_abc12345'), env as never);
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 200);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const listResult = await authenticateRequest(new Request('https://example.com/api/jobs'), env as never);
    assert.equal('authContext' in listResult, true);

    const eventsResult = await authenticateRequest(new Request('https://example.com/api/jobs/job_abc12345/events'), env as never);
    assert.equal('authContext' in eventsResult, true);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const result = await authenticateRequest(new Request('https://example.com/api/reviews/rev_abc123/events'), env as never);
    assert.equal('response' in result, true);
    const response = (result as { response: Response }).response;
    assert.equal(response.status, 401);
  }
}
