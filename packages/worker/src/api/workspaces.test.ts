import { strict as assert } from 'assert';
import {
  handleCreateWorkspace,
  handleDeleteWorkspace,
  handleGetWorkspaceDiff,
  handleGetWorkspaceFile,
  handleGetWorkspace,
  handleGetWorkspaceEvents,
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
