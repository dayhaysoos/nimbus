import { strict as assert } from 'assert';
import {
  handleCreateWorkspaceGithubFork,
  handleCreateWorkspacePatchExport,
  handleCreateWorkspaceZipExport,
  handleCreateWorkspace,
  handleDeleteWorkspace,
  handleGetWorkspaceDiff,
  handleGetWorkspaceFile,
  handleGetWorkspaceOperation,
  handleGetWorkspace,
  handleGetWorkspaceEvents,
  handleListWorkspaceArtifacts,
  handleListWorkspaceFiles,
  parseDiffNameStatus,
  trimNameStatusToCompleteRecords,
  parseWorkspaceListEntries,
  assertWorkspaceRootSafe,
  truncateChangedFilesByBytes,
  truncateUtf8,
  handleResetWorkspace,
} from './workspaces.js';

function createEnvWithEmptyWorkspace(): unknown {
  return {
    DB: {
      prepare() {
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
                return { success: true, meta: { changes: 0 } };
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
      get() {
        return {};
      },
    },
  };
}

function createEnvWithReadyWorkspace(): unknown {
  return {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_ready',
                    status: 'ready',
                    source_type: 'checkpoint',
                    checkpoint_id: '8a513f56ed70',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'workspaces/ws_ready/source/a.tar.gz',
                    source_bundle_sha256: 'f'.repeat(64),
                    source_bundle_bytes: 123,
                    sandbox_id: 'workspace-ws_ready',
                    baseline_ready: 1,
                    error_code: null,
                    error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-07T00:00:00.000Z',
                    updated_at: '2026-03-07T00:00:00.000Z',
                    deleted_at: null,
                  } as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
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
      get() {
        return {
          async exec() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
      },
    },
  };
}

function createEnvWithCreatingWorkspace(): unknown {
  return {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_creating',
                    status: 'creating',
                    source_type: 'checkpoint',
                    checkpoint_id: '8a513f56ed70',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'workspaces/ws_creating/source/a.tar.gz',
                    source_bundle_sha256: 'f'.repeat(64),
                    source_bundle_bytes: 123,
                    sandbox_id: 'workspace-ws_creating',
                    baseline_ready: 0,
                    error_code: null,
                    error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-07T00:00:00.000Z',
                    updated_at: '2026-03-07T00:00:00.000Z',
                    deleted_at: null,
                  } as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
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
      get() {
        return {
          async exec() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
      },
    },
  };
}

function createEnvWithReadyWorkspaceMissingBaseline(): unknown {
  return {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_ready_no_baseline',
                    status: 'ready',
                    source_type: 'checkpoint',
                    checkpoint_id: '8a513f56ed70',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'workspaces/ws_ready_no_baseline/source/a.tar.gz',
                    source_bundle_sha256: 'f'.repeat(64),
                    source_bundle_bytes: 123,
                    sandbox_id: 'workspace-ws_ready_no_baseline',
                    baseline_ready: 0,
                    error_code: null,
                    error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-03-07T00:00:00.000Z',
                    updated_at: '2026-03-07T00:00:00.000Z',
                    deleted_at: null,
                  } as T;
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
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
      get() {
        return {
          async exec() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
      },
    },
  };
}

type MockGithubResponse = {
  status: number;
  body?: unknown;
};

function createForkOperationTestEnv(options?: {
  payload?: Record<string, unknown>;
  oversizedFilesJson?: string;
  secretFilesOutput?: string;
  commitShaOutput?: string;
  operationOverrides?: Partial<{
    status: string;
    result_json: string | null;
    warnings_json: string;
    error_code: string | null;
    error_message: string | null;
    error_details_json: string | null;
  }>;
}): unknown {
  const workspace = {
    id: 'ws_fork',
    status: 'ready',
    source_type: 'checkpoint',
    checkpoint_id: '8a513f56ed70',
    commit_sha: 'a'.repeat(40),
    source_ref: 'main',
    source_project_root: '.',
    source_bundle_key: 'workspaces/ws_fork/source/a.tar.gz',
    source_bundle_sha256: 'f'.repeat(64),
    source_bundle_bytes: 123,
    sandbox_id: 'workspace-ws_fork',
    baseline_ready: 1,
    error_code: null,
    error_message: null,
    last_event_seq: 0,
    created_at: '2026-03-07T00:00:00.000Z',
    updated_at: '2026-03-07T00:00:00.000Z',
    deleted_at: null,
  };

  const operation: {
    id: string;
    workspace_id: string;
    type: string;
    status: string;
    actor_id: string | null;
    auth_principal_json: string;
    request_payload_json: string;
    request_payload_sha256: string;
    idempotency_key: string;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    result_json: string | null;
    warnings_json: string;
    error_code: string | null;
    error_class: string | null;
    error_message: string | null;
    error_details_json: string | null;
    created_at: string;
    updated_at: string;
  } = {
    id: 'op_fork',
    workspace_id: 'ws_fork',
    type: 'fork_github',
    status: 'queued',
    actor_id: null,
    auth_principal_json: '{}',
    request_payload_json:
      JSON.stringify(
        options?.payload ?? {
          target: { owner: 'acme', repo: 'backend' },
        }
      ) || '{}',
    request_payload_sha256: 'hash',
    idempotency_key: 'idem-fork',
    started_at: null,
    finished_at: null,
    duration_ms: null,
    result_json: null,
    warnings_json: '[]',
    error_code: null,
    error_class: null,
    error_message: null,
    error_details_json: null,
    created_at: '2026-03-07T00:00:00.000Z',
    updated_at: '2026-03-07T00:00:00.000Z',
  };

  if (options?.operationOverrides) {
    Object.assign(operation, options.operationOverrides);
  }

  return {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind(id: string) {
              return {
                async first<T>() {
                  return id === workspace.id ? ({ ...workspace } as T) : null;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_operations WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind(id: string, workspaceId: string) {
              return {
                async first<T>() {
                  if (id !== operation.id || workspaceId !== operation.workspace_id) {
                    return null;
                  }
                  return { ...operation } as T;
                },
              };
            },
          };
        }

        if (/SELECT request_payload_json FROM workspace_operations WHERE id = \?/i.test(sql)) {
          return {
            bind(id: string) {
              return {
                async first<T>() {
                  if (id !== operation.id) {
                    return null;
                  }
                  return { request_payload_json: operation.request_payload_json } as T;
                },
              };
            },
          };
        }

        if (/UPDATE workspace_operations SET/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  operation.status = String(values[0]);
                  operation.updated_at = new Date().toISOString();

                  for (const value of values) {
                    if (typeof value !== 'string') {
                      continue;
                    }
                    if (
                      value === 'branch_exists' ||
                      value === 'file_too_large_for_github' ||
                      value === 'target_repo_not_allowed' ||
                      value === 'operation_failed' ||
                      value === 'no_changes'
                    ) {
                      operation.error_code = value;
                      continue;
                    }
                    if (value.startsWith('[') && value.includes('baseline_stale')) {
                      operation.warnings_json = value;
                      continue;
                    }
                    if (value.startsWith('{') && value.includes('commitSha')) {
                      operation.result_json = value;
                    }
                    if (value.startsWith('{') && value.includes('files')) {
                      operation.error_details_json = value;
                    }
                    if (value.includes('exists') || value.includes('GitHub') || value.includes('Workspace')) {
                      operation.error_message = value;
                    }
                  }

                  if (operation.status === 'failed' && !operation.error_code) {
                    operation.error_code = 'operation_failed';
                  }
                  if (operation.status === 'failed' && !operation.error_message) {
                    operation.error_message = 'operation failed';
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
              async first<T>() {
                return null as T;
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
      get() {
        return {
          async exec(command: string) {
            if (command.includes('git rev-parse --verify HEAD')) {
              return { stdout: '', stderr: '', exitCode: 0 };
            }
            if (command.includes('python3 - 104857600')) {
              return {
                stdout: options?.oversizedFilesJson ?? '[]',
                stderr: '',
                exitCode: 0,
              };
            }
            if (command.includes('git ls-files -co --exclude-standard')) {
              return {
                stdout: options?.secretFilesOutput ?? '',
                stderr: '',
                exitCode: 0,
              };
            }
            if (command.includes('tmp_repo=$(mktemp /tmp/nimbus-fork')) {
              return {
                stdout: options?.commitShaOutput ?? `${'b'.repeat(40)}\n`,
                stderr: '',
                exitCode: 0,
              };
            }

            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
      },
    },
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-tests',
    GITHUB_APP_JWT: 'test-app-jwt',
  };
}

async function withMockFetch(
  handler: (url: URL, init: RequestInit) => MockGithubResponse,
  callback: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const mock = handler(url, init ?? {});
    return new Response(mock.body === undefined ? undefined : JSON.stringify(mock.body), {
      status: mock.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runWorkspaceApiTests(): Promise<void> {
  {
    const request = new Request('https://example.com/api/workspaces', {
      method: 'POST',
      body: new FormData(),
    });
    const response = await handleCreateWorkspace(request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 500);
  }

  {
    const response = await handleGetWorkspace('ws_missing', createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_missing/events');
    const response = await handleGetWorkspaceEvents('ws_missing', request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const response = await handleResetWorkspace('ws_missing', createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 500);
  }

  {
    const response = await handleDeleteWorkspace('ws_missing', createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_missing/files?path=src');
    const response = await handleListWorkspaceFiles('ws_missing', request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_missing/file?path=src/index.ts');
    const response = await handleGetWorkspaceFile('ws_missing', request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_missing/diff');
    const response = await handleGetWorkspaceDiff('ws_missing', request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_missing/export/zip', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
    });
    const response = await handleCreateWorkspaceZipExport('ws_missing', request, createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_ready/export/patch', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleCreateWorkspacePatchExport('ws_ready', request, createEnvWithReadyWorkspace() as never);
    assert.equal(response.status, 400);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_ready/fork/github', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await handleCreateWorkspaceGithubFork('ws_ready', request, createEnvWithReadyWorkspace() as never);
    assert.equal(response.status, 400);
  }

  {
    const response = await handleGetWorkspaceOperation('ws_missing', 'op_abc', createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const response = await handleListWorkspaceArtifacts('ws_missing', createEnvWithEmptyWorkspace() as never);
    assert.equal(response.status, 404);
  }

  {
    const env = {
      DB: {
        prepare(sql: string) {
          if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'ws_fork_stale',
                      status: 'ready',
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: '.',
                      source_bundle_key: 'workspaces/ws_fork_stale/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 123,
                      sandbox_id: 'workspace-ws_fork_stale',
                      baseline_ready: 1,
                      error_code: null,
                      error_message: null,
                      last_event_seq: 0,
                      created_at: '2026-03-07T00:00:00.000Z',
                      updated_at: '2026-03-07T00:00:00.000Z',
                      deleted_at: null,
                    } as T;
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
                    return {
                      id: 'op_stale',
                      workspace_id: 'ws_fork_stale',
                      type: 'fork_github',
                      status: 'succeeded',
                      actor_id: null,
                      auth_principal_json: '{}',
                      request_payload_json: '{}',
                      request_payload_sha256: 'hash',
                      idempotency_key: 'idem',
                      started_at: '2026-03-07T00:00:01.000Z',
                      finished_at: '2026-03-07T00:00:02.000Z',
                      duration_ms: 1000,
                      result_json: JSON.stringify({ commitSha: 'b'.repeat(40) }),
                      warnings_json: JSON.stringify([{ code: 'baseline_stale' }]),
                      error_code: null,
                      error_class: null,
                      error_message: null,
                      error_details_json: null,
                      created_at: '2026-03-07T00:00:00.000Z',
                      updated_at: '2026-03-07T00:00:02.000Z',
                    } as T;
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

    const response = await handleGetWorkspaceOperation('ws_fork_stale', 'op_stale', env as never);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      operation: { status: string; warnings?: Array<{ code?: string }>; result?: { commitSha?: string } };
    };
    assert.equal(body.operation.status, 'succeeded');
    assert.equal(body.operation.result?.commitSha, 'b'.repeat(40));
    assert.equal(body.operation.warnings?.some((warning) => warning.code === 'baseline_stale'), true);
  }

  {
    const env = createForkOperationTestEnv({
      operationOverrides: {
        status: 'failed',
        error_code: 'branch_exists',
        error_message: 'Requested branch already exists',
      },
    });
    const response = await handleGetWorkspaceOperation('ws_fork', 'op_fork', env as never);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      operation: { status: string; error?: { code?: string } };
    };
    assert.equal(body.operation.status, 'failed');
    assert.equal(body.operation.error?.code, 'branch_exists');
  }

  {
    const env = createForkOperationTestEnv({
      operationOverrides: {
        status: 'failed',
        error_code: 'file_too_large_for_github',
        error_message: 'Workspace contains files over GitHub blob limit',
      },
    });
    const response = await handleGetWorkspaceOperation('ws_fork', 'op_fork', env as never);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      operation: { status: string; error?: { code?: string } };
    };
    assert.equal(body.operation.status, 'failed');
    assert.equal(body.operation.error?.code, 'file_too_large_for_github');
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_ready/files?path=../etc');
    const response = await handleListWorkspaceFiles('ws_ready', request, createEnvWithReadyWorkspace() as never);
    assert.equal(response.status, 400);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_ready/file?path=../etc/passwd');
    const response = await handleGetWorkspaceFile('ws_ready', request, createEnvWithReadyWorkspace() as never);
    assert.equal(response.status, 400);
  }

  assert.throws(() => assertWorkspaceRootSafe('/etc'), /Resolved path escapes workspace root/);
  assert.doesNotThrow(() => assertWorkspaceRootSafe('/workspace'));
  assert.doesNotThrow(() => assertWorkspaceRootSafe('/workspace/src/index.ts'));

  {
    const parsed = parseDiffNameStatus('A\u0000a.txt\u0000M\u0000b.txt\u0000D\u0000c.txt\u0000R100\u0000old.txt\u0000new.txt\u0000');
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed[0], { status: 'added', path: 'a.txt' });
    assert.deepEqual(parsed[1], { status: 'modified', path: 'b.txt' });
    assert.deepEqual(parsed[2], { status: 'deleted', path: 'c.txt' });
    assert.deepEqual(parsed[3], {
      status: 'renamed',
      previousPath: 'old.txt',
      path: 'new.txt',
    });
  }

  {
    const trimmed = trimNameStatusToCompleteRecords('A\u0000a.txt\u0000M\u0000partial');
    const parsed = parseDiffNameStatus(trimmed);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], { status: 'added', path: 'a.txt' });
  }

  {
    const trimmed = trimNameStatusToCompleteRecords('A\u0000a.txt\u0000M');
    const parsed = parseDiffNameStatus(trimmed);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], { status: 'added', path: 'a.txt' });
  }

  {
    const entries = parseWorkspaceListEntries('foo\u0000file\u0000bar baz\u0000directory\u0000x\ny.ts\u0000file\u0000', '.');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], { path: 'foo', type: 'file' });
    assert.deepEqual(entries[1], { path: 'bar baz', type: 'directory' });
    assert.deepEqual(entries[2], { path: 'x\ny.ts', type: 'file' });
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_creating/files?path=src');
    const response = await handleListWorkspaceFiles('ws_creating', request, createEnvWithCreatingWorkspace() as never);
    assert.equal(response.status, 409);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_creating/file?path=src/index.ts');
    const response = await handleGetWorkspaceFile('ws_creating', request, createEnvWithCreatingWorkspace() as never);
    assert.equal(response.status, 409);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_creating/diff');
    const response = await handleGetWorkspaceDiff('ws_creating', request, createEnvWithCreatingWorkspace() as never);
    assert.equal(response.status, 409);
  }

  {
    const request = new Request('https://example.com/api/workspaces/ws_ready_no_baseline/diff');
    const response = await handleGetWorkspaceDiff(
      'ws_ready_no_baseline',
      request,
      createEnvWithReadyWorkspaceMissingBaseline() as never
    );
    assert.equal(response.status, 409);
  }

  {
    const changedFiles = [
      { status: 'added' as const, path: 'src/a.ts' },
      { status: 'added' as const, path: 'src/b.ts' },
      { status: 'added' as const, path: 'src/c.ts' },
      { status: 'added' as const, path: 'src/d.ts' },
      { status: 'added' as const, path: 'src/e.ts' },
    ];
    const truncated = truncateChangedFilesByBytes(changedFiles, 40);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.files.length < changedFiles.length, true);
    assert.equal(truncated.bytes <= 40, true);
  }

  {
    const truncated = truncateUtf8('😀😀😀😀', 5);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.returnedBytes <= 5, true);
  }

  {
    let failedStatusUpdates = 0;
    const env = {
      DB: {
        prepare(sql: string) {
          if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'ws_reset_fail',
                      status: 'ready',
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: '.',
                      source_bundle_key: 'workspaces/ws_reset_fail/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 123,
                      sandbox_id: 'workspace-ws_reset_fail',
                      baseline_ready: 1,
                      error_code: null,
                      error_message: null,
                      last_event_seq: 0,
                      created_at: '2026-03-07T00:00:00.000Z',
                      updated_at: '2026-03-07T00:00:00.000Z',
                      deleted_at: null,
                    } as T;
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET status = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    failedStatusUpdates += 1;
                    return { success: true, meta: { changes: 1 } };
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

          if (/INSERT INTO workspace_events/i.test(sql)) {
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
          return {
            async arrayBuffer() {
              throw new Error('bundle read failed');
            },
          };
        },
      },
    };

    const response = await handleResetWorkspace('ws_reset_fail', env as never);
    assert.equal(response.status, 500);
    assert.equal(failedStatusUpdates > 0, true);
  }

  {
    let failedStatusUpdates = 0;
    const env = {
      DB: {
        prepare(sql: string) {
          if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'ws_delete_fail',
                      status: 'ready',
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: '.',
                      source_bundle_key: 'workspaces/ws_delete_fail/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 123,
                      sandbox_id: 'workspace-ws_delete_fail',
                      baseline_ready: 1,
                      error_code: null,
                      error_message: null,
                      last_event_seq: 0,
                      created_at: '2026-03-07T00:00:00.000Z',
                      updated_at: '2026-03-07T00:00:00.000Z',
                      deleted_at: null,
                    } as T;
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET status = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    failedStatusUpdates += 1;
                    return { success: true, meta: { changes: 1 } };
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

          if (/INSERT INTO workspace_events/i.test(sql)) {
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
        get() {
          return {};
        },
      },
      SOURCE_BUNDLES: {
        async delete() {
          return;
        },
      },
    };

    const response = await handleDeleteWorkspace('ws_delete_fail', env as never);
    assert.equal(response.status, 500);
    assert.equal(failedStatusUpdates > 0, true);
  }

  {
    let failedStatusUpdates = 0;
    const env = {
      DB: {
        prepare(sql: string) {
          if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'ws_delete_partial',
                      status: 'ready',
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: '.',
                      source_bundle_key: 'workspaces/ws_delete_partial/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 123,
                      sandbox_id: 'workspace-ws_delete_partial',
                      baseline_ready: 1,
                      error_code: null,
                      error_message: null,
                      last_event_seq: 0,
                      created_at: '2026-03-07T00:00:00.000Z',
                      updated_at: '2026-03-07T00:00:00.000Z',
                      deleted_at: null,
                    } as T;
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET status = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    failedStatusUpdates += 1;
                    return { success: true, meta: { changes: 1 } };
                  },
                };
              },
            };
          }

          if (/UPDATE workspaces SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
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

          if (/INSERT INTO workspace_events/i.test(sql)) {
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
        get() {
          return {
            async destroy() {
              return;
            },
          };
        },
      },
      SOURCE_BUNDLES: {
        async delete() {
          throw new Error('r2 unavailable');
        },
      },
    };

    const response = await handleDeleteWorkspace('ws_delete_partial', env as never);
    assert.equal(response.status === 503 || response.status === 500, true);
    assert.equal(failedStatusUpdates > 0, true);
  }
}
