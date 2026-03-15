import { strict as assert } from 'assert';
import { handleGetWorkspace } from './api/workspaces.js';
import { handleGetReview } from './api/reviews.js';
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
  keyAccountId?: string;
  keyIsAdmin?: boolean;
  workspaceExists?: boolean;
  workspaceAccountId?: string | null;
  reviewExists?: boolean;
  reviewAccountId?: string | null;
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
                      account_id: options?.keyAccountId ?? 'acct_123',
                      is_admin: options?.keyIsAdmin ? 1 : 0,
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

        if (sql.includes('SELECT account_id FROM workspaces WHERE id = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.workspaceExists === false) {
                    return null;
                  }
                  return {
                    account_id:
                      options && 'workspaceAccountId' in options ? (options.workspaceAccountId ?? null) : 'acct_123',
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

        if (sql.includes('SELECT account_id FROM review_runs WHERE id = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.reviewExists === false) {
                    return null;
                  }
                  return {
                    account_id: options && 'reviewAccountId' in options ? (options.reviewAccountId ?? null) : 'acct_123',
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

        if (sql.includes('SELECT * FROM review_runs WHERE id = ?')) {
          return {
            bind() {
              return {
                async first<T>() {
                  if (options?.reviewExists === false) {
                    return null;
                  }
                  return {
                    id: 'rev_abc12345',
                    workspace_id: 'ws_abc12345',
                    deployment_id: 'dep_abcd1234',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem-review',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash',
                    provenance_json: '{}',
                    last_event_seq: 1,
                    attempt_count: 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-03-15T00:00:00.000Z',
                    updated_at: '2026-03-15T00:00:00.000Z',
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
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash, keyAccountId: 'acct_123', workspaceAccountId: null });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': validKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 404);
  }

  {
    const env = createWorkerTestEnv({
      hosted: true,
      keyHash: validKeyHash,
      keyAccountId: 'acct_123',
      workspaceAccountId: 'acct_999',
    });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': validKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 404);
  }

  {
    const adminKey = 'nmb_live_admin123';
    const adminKeyHash = await sha256Hex(adminKey);
    const env = createWorkerTestEnv({
      hosted: true,
      keyHash: adminKeyHash,
      keyAccountId: 'acct_admin',
      keyIsAdmin: true,
      workspaceAccountId: null,
    });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': adminKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 200);
  }

  {
    const adminKey = 'nmb_live_admin456';
    const adminKeyHash = await sha256Hex(adminKey);
    const env = createWorkerTestEnv({
      hosted: true,
      keyHash: adminKeyHash,
      keyAccountId: 'acct_admin',
      keyIsAdmin: true,
      workspaceAccountId: 'acct_other',
    });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/workspaces/ws_abc12345', {
        headers: { 'X-Nimbus-Api-Key': adminKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetWorkspace('ws_abc12345', env as never, (authResult as { authContext: AuthContext }).authContext);
    assert.equal(response.status, 200);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash, keyAccountId: 'acct_123', reviewAccountId: 'acct_123' });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/reviews/rev_abc12345', {
        headers: { 'X-Nimbus-Api-Key': validKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetReview(
      'rev_abc12345',
      new Request('https://example.com/api/reviews/rev_abc12345'),
      env as never,
      (authResult as { authContext: AuthContext }).authContext
    );
    assert.equal(response.status, 200);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash, keyAccountId: 'acct_123', reviewAccountId: 'acct_999' });
    const authResult = await authenticateRequest(
      new Request('https://example.com/api/reviews/rev_abc12345', {
        headers: { 'X-Nimbus-Api-Key': validKey },
      }),
      env as never
    );
    assert.equal('authContext' in authResult, true);
    const response = await handleGetReview(
      'rev_abc12345',
      new Request('https://example.com/api/reviews/rev_abc12345'),
      env as never,
      (authResult as { authContext: AuthContext }).authContext
    );
    assert.equal(response.status, 404);
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
    assert.equal('response' in listResult, true);
    const listResponse = (listResult as { response: Response }).response;
    assert.equal(listResponse.status, 401);

    const eventsResult = await authenticateRequest(new Request('https://example.com/api/jobs/job_abc12345/events'), env as never);
    assert.equal('response' in eventsResult, true);
    const eventsResponse = (eventsResult as { response: Response }).response;
    assert.equal(eventsResponse.status, 401);
  }

  {
    const env = createWorkerTestEnv({ hosted: true, keyHash: validKeyHash });
    const result = await authenticateRequest(new Request('https://example.com/api/reviews/rev_abc123/events'), env as never);
    assert.equal('response' in result, true);
    const response = (result as { response: Response }).response;
    assert.equal(response.status, 401);
  }
}
