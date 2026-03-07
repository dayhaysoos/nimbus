import { strict as assert } from 'assert';
import {
  handleCreateWorkspace,
  handleDeleteWorkspace,
  handleGetWorkspace,
  handleGetWorkspaceEvents,
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
