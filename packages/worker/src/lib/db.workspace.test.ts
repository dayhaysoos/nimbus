import { strict as assert } from 'assert';
import {
  appendWorkspaceEvent,
  createWorkspace,
  listWorkspaceEvents,
  markWorkspaceDeleted,
  markWorkspaceReady,
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
}
