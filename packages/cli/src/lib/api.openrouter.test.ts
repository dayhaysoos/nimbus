import { strict as assert } from 'assert';
import { createReview, createWorkspace } from './api.js';

export async function runApiOpenrouterHeaderTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalOpenrouterApiKey = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENROUTER_API_KEY = 'or-test-key-123';

    {
      let capturedHeader: string | null = null;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        capturedHeader = headers.get('X-Openrouter-Api-Key');
        return new Response(
          JSON.stringify({
            reviewId: 'rev_abc12345',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_abc12345/events',
            resultUrl: '/api/reviews/rev_abc12345',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      await createReview('https://worker.example.com', 'idem-openrouter', {
        target: {
          type: 'workspace_deployment',
          workspaceId: 'ws_abc12345',
          deploymentId: 'dep_abc12345',
        },
        mode: 'report_only',
      });

      assert.equal(capturedHeader, 'or-test-key-123');
    }

    {
      let capturedHeader: string | null = null;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        capturedHeader = headers.get('X-Openrouter-Api-Key');
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
      }) as typeof fetch;

      const formData = new FormData();
      formData.set('metadata', '{}');
      formData.set('bundle', new File([new Uint8Array([1])], 'source.tar.gz', { type: 'application/gzip' }));
      await createWorkspace('https://worker.example.com', formData);

      assert.equal(capturedHeader, null);
    }
  } finally {
    if (originalOpenrouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenrouterApiKey;
    }
    globalThis.fetch = originalFetch;
  }
}
