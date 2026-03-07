import { strict as assert } from 'assert';
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceDiff,
  getWorkspaceFile,
  listWorkspaceFiles,
} from './api.js';

export async function runWorkspaceApiTests(): Promise<void> {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/workspaces') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            workspace: {
              id: 'ws_abc12345',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: 'a'.repeat(40),
              sourceRef: 'main',
              sourceProjectRoot: '.',
              sourceBundleKey: 'workspaces/ws_abc12345/source/a.tar.gz',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 4,
              sandboxId: 'workspace-ws_abc12345',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-07T00:00:00.000Z',
              updatedAt: '2026-03-07T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_abc12345/events',
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/workspaces/ws_abc12345') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ workspaceId: 'ws_abc12345', status: 'deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/workspaces/ws_abc12345') && (!init || !init.method)) {
        return new Response(
          JSON.stringify({
            id: 'ws_abc12345',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: 'a'.repeat(40),
            sourceRef: 'main',
            sourceProjectRoot: '.',
            sourceBundleKey: 'workspaces/ws_abc12345/source/a.tar.gz',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 4,
            sandboxId: 'workspace-ws_abc12345',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-07T00:00:00.000Z',
            updatedAt: '2026-03-07T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_abc12345/events',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/api/workspaces/ws_abc12345/files')) {
        return new Response(
          JSON.stringify({
            workspaceId: 'ws_abc12345',
            path: 'src',
            entries: [
              { path: 'src/index.ts', type: 'file' },
              { path: 'src/lib', type: 'directory' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/api/workspaces/ws_abc12345/file')) {
        return new Response(
          JSON.stringify({
            workspaceId: 'ws_abc12345',
            path: 'src/index.ts',
            sizeBytes: 42,
            maxBytes: 200,
            truncated: false,
            content: 'console.log("hello")\n',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/api/workspaces/ws_abc12345/diff')) {
        return new Response(
          JSON.stringify({
            workspaceId: 'ws_abc12345',
            includePatch: true,
            maxBytes: 1024,
            truncated: false,
            summary: {
              added: 1,
              modified: 0,
              deleted: 0,
              renamed: 0,
              totalChanged: 1,
            },
            changedFiles: [{ path: 'src/new.ts', status: 'added' }],
            patch: 'diff --git a/src/new.ts b/src/new.ts',
            patchBytes: 36,
            patchTotalBytes: 36,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const formData = new FormData();
    formData.set('metadata', '{}');
    formData.set('bundle', new File([new Uint8Array([1])], 'source.tar.gz', { type: 'application/gzip' }));

    const created = await createWorkspace('https://worker.example.com', formData);
    assert.equal(created.workspace.id, 'ws_abc12345');

    const workspace = await getWorkspace('https://worker.example.com', 'ws_abc12345');
    assert.equal(workspace.status, 'ready');

    const deleted = await deleteWorkspace('https://worker.example.com', 'ws_abc12345');
    assert.equal(deleted.status, 'deleted');

    const files = await listWorkspaceFiles('https://worker.example.com', 'ws_abc12345', 'src');
    assert.equal(files.entries.length, 2);
    assert.equal(files.path, 'src');

    const file = await getWorkspaceFile('https://worker.example.com', 'ws_abc12345', 'src/index.ts', 200);
    assert.equal(file.truncated, false);
    assert.equal(file.path, 'src/index.ts');

    const diff = await getWorkspaceDiff('https://worker.example.com', 'ws_abc12345', {
      includePatch: true,
      maxBytes: 1024,
    });
    assert.equal(diff.summary.totalChanged, 1);
    assert.equal(diff.includePatch, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
