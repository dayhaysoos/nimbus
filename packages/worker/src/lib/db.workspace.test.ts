import { strict as assert } from 'assert';
import {
  appendWorkspaceEvent,
  createWorkspaceArtifact,
  createWorkspaceOperation,
  createWorkspace,
  getWorkspaceOperation,
  listWorkspaceEvents,
  listWorkspaceArtifacts,
  markWorkspaceDeleted,
  markWorkspaceReady,
  WorkspaceIdempotencyConflictError,
} from './db.js';

export async function runWorkspaceDbTests(): Promise<void> {
  {
    const sqlStatements: string[] = [];
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql);
        return {
          bind(...values: unknown[]) {
            return {
              async first<T>() {
                return {
                  id: values[0],
                  status: 'creating',
                  source_type: values[1],
                  checkpoint_id: values[2],
                  commit_sha: values[3],
                  source_ref: values[4],
                  source_project_root: values[5],
                  source_bundle_key: values[6],
                  source_bundle_sha256: values[7],
                  source_bundle_bytes: values[8],
                  sandbox_id: values[9],
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
      },
    } as unknown as D1Database;

    const created = await createWorkspace(db, {
      id: 'ws_abc12345',
      sourceType: 'checkpoint',
      checkpointId: '8a513f56ed70',
      commitSha: 'a'.repeat(40),
      sourceRef: 'main',
      sourceProjectRoot: 'apps/web',
      sourceBundleKey: 'workspaces/ws_abc12345/source/a.tar.gz',
      sourceBundleSha256: 'f'.repeat(64),
      sourceBundleBytes: 1024,
      sandboxId: 'workspace-ws_abc12345',
    });

    assert.equal(created.id, 'ws_abc12345');
    assert.equal(created.status, 'creating');
    assert.equal(created.checkpointId, '8a513f56ed70');
    assert.equal(created.sandboxId, 'workspace-ws_abc12345');
    assert.equal(created.baselineReady, false);
    assert.equal(created.eventsUrl, '/api/workspaces/ws_abc12345/events');
    assert.ok(sqlStatements.some((sql) => /INSERT INTO workspaces/i.test(sql)));
  }

  {
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            updates.push({ sql, values });
            return {
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await markWorkspaceReady(db, 'ws_abc12345');
    await markWorkspaceDeleted(db, 'ws_abc12345');

    assert.equal(updates.length, 2);
    assert.ok(updates.every((entry) => /UPDATE workspaces SET/i.test(entry.sql)));
    assert.equal(updates[0].values[0], 'ready');
    assert.equal(updates[1].values[0], 'deleted');
  }

  {
    let insertValues: unknown[] = [];
    const db = {
      prepare(sql: string) {
        if (/RETURNING last_event_seq/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { last_event_seq: 3 } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_events/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              insertValues = values;
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
              async all<T>() {
                return {
                  results: [
                    {
                      seq: 1,
                      event_type: 'workspace_created',
                      payload_json: '{"ok":true}',
                      created_at: '2026-03-07T00:00:00.000Z',
                    },
                  ],
                } as unknown as T;
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const seq = await appendWorkspaceEvent(db, {
      workspaceId: 'ws_abc12345',
      eventType: 'workspace_created',
      payload: { ok: true },
    });
    assert.equal(seq, 3);
    assert.equal(insertValues[0], 'ws_abc12345');
    assert.equal(insertValues[1], 3);
    assert.equal(insertValues[2], 'workspace_created');

    const events = await listWorkspaceEvents(db, 'ws_abc12345');
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'workspace_created');
    assert.deepEqual(events[0].payload, { ok: true });
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT operation_id, request_payload_sha256, expires_at/i.test(sql)) {
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

        if (/INSERT INTO workspace_operations/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    type: values[2],
                    status: 'queued',
                    actor_id: null,
                    auth_principal_json: '{}',
                    request_payload_json: '{}',
                    request_payload_sha256: values[6],
                    idempotency_key: values[7],
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
                  } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_operation_idempotency/i.test(sql)) {
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

        if (/SELECT \* FROM workspace_operations WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'op_existing',
                    workspace_id: 'ws_abc12345',
                    type: 'export_zip',
                    status: 'queued',
                    actor_id: null,
                    auth_principal_json: '{}',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash-a',
                    idempotency_key: 'idem-a',
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
            };
          },
        };
      },
    } as unknown as D1Database;

    const operationCreated = await createWorkspaceOperation(db, {
      id: 'op_created',
      workspaceId: 'ws_abc12345',
      type: 'export_zip',
      idempotencyKey: 'idem-a',
      requestPayload: {},
      requestPayloadSha256: 'hash-a',
    });
    assert.equal(operationCreated.operation.id, 'op_created');
    assert.equal(operationCreated.reused, false);

    const operationFetched = await getWorkspaceOperation(db, 'ws_abc12345', 'op_existing');
    assert.equal(operationFetched?.id, 'op_existing');
  }

  {
    const db = {
      prepare(sql: string) {
        if (/SELECT operation_id, request_payload_sha256, expires_at/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    operation_id: 'op_existing',
                    request_payload_sha256: 'different-hash',
                    expires_at: '2999-01-01T00:00:00.000Z',
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
            };
          },
        };
      },
    } as unknown as D1Database;

    await assert.rejects(
      createWorkspaceOperation(db, {
        id: 'op_created',
        workspaceId: 'ws_abc12345',
        type: 'export_patch',
        idempotencyKey: 'idem-conflict',
        requestPayload: {},
        requestPayloadSha256: 'hash-a',
      }),
      (error: unknown) => error instanceof WorkspaceIdempotencyConflictError
    );
  }

  {
    const db = {
      prepare(sql: string) {
        if (/INSERT INTO workspace_artifacts/i.test(sql)) {
          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  return {
                    id: values[0],
                    workspace_id: values[1],
                    operation_id: values[2],
                    type: values[3],
                    status: 'available',
                    object_key: values[4],
                    bytes: values[5],
                    content_type: values[6],
                    sha256: values[7],
                    source_baseline_sha: values[8],
                    creator_id: values[9],
                    retention_expires_at: values[10],
                    expired_at: null,
                    warnings_json: values[11],
                    metadata_json: values[12],
                    created_at: '2026-03-07T00:00:00.000Z',
                    updated_at: '2026-03-07T00:00:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_artifacts WHERE workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: [
                      {
                        id: 'art_abc',
                        workspace_id: 'ws_abc12345',
                        operation_id: 'op_abc',
                        type: 'patch',
                        status: 'available',
                        object_key: 'workspaces/ws_abc/artifacts/art_abc.patch',
                        bytes: 10,
                        content_type: 'text/x-diff',
                        sha256: 'f'.repeat(64),
                        source_baseline_sha: 'a'.repeat(40),
                        creator_id: null,
                        retention_expires_at: '2999-01-01T00:00:00.000Z',
                        expired_at: null,
                        warnings_json: '[]',
                        metadata_json: '{}',
                        created_at: '2026-03-07T00:00:00.000Z',
                        updated_at: '2026-03-07T00:00:00.000Z',
                      },
                    ],
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
            };
          },
        };
      },
    } as unknown as D1Database;

    const artifact = await createWorkspaceArtifact(db, {
      id: 'art_new',
      workspaceId: 'ws_abc12345',
      operationId: 'op_abc',
      type: 'patch',
      objectKey: 'workspaces/ws_abc/artifacts/art_new.patch',
      bytes: 128,
      contentType: 'text/x-diff',
      sha256: 'e'.repeat(64),
      sourceBaselineSha: 'a'.repeat(40),
      retentionExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    assert.equal(artifact.id, 'art_new');

    const artifacts = await listWorkspaceArtifacts(db, 'ws_abc12345');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, 'art_abc');
  }
}
