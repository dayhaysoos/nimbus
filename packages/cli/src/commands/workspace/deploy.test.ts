import { strict as assert } from 'assert';
import { setWorkspaceDeployIntentContextResolverForTests, workspaceDeployCommand } from './deploy.js';

export async function runWorkspaceDeployCommandTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;
  process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

  try {
    setWorkspaceDeployIntentContextResolverForTests(async () => ({
      note: 'Review with Entire session intent context (ses_test).',
      sessionIds: ['ses_test'],
      transcriptUrl: null,
      intentSessionContext: ['Do not leak auth tokens.', 'Keep deploy path non-mutating.'],
    }));

    {
      setWorkspaceDeployIntentContextResolverForTests(async () => {
        throw new Error('intent context resolver should not run for preflight-only mode');
      });
      globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/deploy/preflight')) {
          return new Response(
            JSON.stringify({
              preflight: {
                ok: true,
                checks: [{ code: 'workspace_ready', ok: true }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in legacy preflight test: ${url}`);
      }) as typeof fetch;

      await workspaceDeployCommand('ws_abc12345', {
        preflightOnly: true,
      });

      setWorkspaceDeployIntentContextResolverForTests(async () => ({
        note: 'Review with Entire session intent context (ses_test).',
        sessionIds: ['ses_test'],
        transcriptUrl: null,
        intentSessionContext: ['Do not leak auth tokens.', 'Keep deploy path non-mutating.'],
      }));
    }

    {
      const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body });
        if (
          url.includes('/api/workspaces/ws_abc12345') &&
          !url.endsWith('/deploy/preflight') &&
          !url.endsWith('/deploy') &&
          !url.includes('/deployments/')
        ) {
          return new Response(
            JSON.stringify({
              id: 'ws_abc12345',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: null,
              commitSha: 'a'.repeat(40),
              sourceRef: 'main',
              sourceProjectRoot: '.',
              sourceBundleKey: 'key',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 1,
              sandboxId: 'workspace-ws_abc12345',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              lastDeploymentId: null,
              lastDeploymentStatus: null,
              lastDeployedUrl: null,
              lastDeployedAt: null,
              lastDeploymentErrorCode: null,
              lastDeploymentErrorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_abc12345/events',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy/preflight')) {
          return new Response(
            JSON.stringify({
              preflight: {
                ok: true,
                toolchain: {
                  manager: 'npm',
                  version: '10.8.2',
                  detectedFrom: 'packageManager',
                  projectRoot: '.',
                  lockfile: null,
                },
                checks: [{ code: 'workspace_ready', ok: true }],
                remediations: [],
              },
              nextAction: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in preflight-only test: ${url}`);
      }) as typeof fetch;

      await workspaceDeployCommand('ws_abc12345', {
        preflightOnly: true,
        runTestsIfPresent: false,
        runBuildIfPresent: false,
        autoFix: true,
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.endsWith('/deploy/preflight'), true);
      assert.deepEqual(requests[0].body?.validation, {
        runBuildIfPresent: false,
        runTestsIfPresent: false,
      });
      assert.deepEqual(requests[0].body?.autoFix, {
        rehydrateBaseline: true,
        bootstrapToolchain: true,
      });
      assert.equal(requests[0].body?.provider, undefined);
    }

    {
      const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body });
        if (url.includes('/api/workspaces/ws_abc12345') && !url.endsWith('/deploy/preflight') && !url.endsWith('/deploy') && !url.endsWith('/deployments/dep_abc123')) {
          return new Response(
            JSON.stringify({
              id: 'ws_abc12345',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: null,
              commitSha: 'a'.repeat(40),
              sourceRef: 'main',
              sourceProjectRoot: '.',
              sourceBundleKey: 'key',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 1,
              sandboxId: 'workspace-ws_abc12345',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              lastDeploymentId: null,
              lastDeploymentStatus: null,
              lastDeployedUrl: null,
              lastDeployedAt: null,
              lastDeploymentErrorCode: null,
              lastDeploymentErrorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_abc12345/events',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy/preflight')) {
          return new Response(
            JSON.stringify({
              preflight: {
                ok: true,
                toolchain: {
                  manager: 'pnpm',
                  version: '9.15.0',
                  detectedFrom: 'packageManager',
                  projectRoot: '.',
                  lockfile: { name: 'pnpm-lock.yaml', sha256: 'abc' },
                },
                checks: [{ code: 'workspace_ready', ok: true }],
                remediations: [],
              },
              nextAction: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy')) {
          return new Response(
            JSON.stringify({ deployment: { id: 'dep_abc123', status: 'queued' } }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deployments/dep_abc123')) {
          return new Response(
            JSON.stringify({ deployment: { id: 'dep_abc123', status: 'succeeded', deployedUrl: 'https://example.dev' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }) as typeof fetch;

      await workspaceDeployCommand('ws_abc12345', {
        idempotencyKey: 'idem-deploy-1',
        runTestsIfPresent: false,
        runBuildIfPresent: false,
        autoFix: true,
        pollIntervalMs: 1,
        provider: 'cloudflare_workers_assets',
        outputDir: 'dist',
      });

      const createRequest = requests.find((request) => request.url.endsWith('/deploy'));
      assert.ok(createRequest);
      assert.deepEqual(createRequest?.body?.validation, {
        runBuildIfPresent: false,
        runTestsIfPresent: false,
      });
      assert.deepEqual(createRequest?.body?.autoFix, {
        rehydrateBaseline: true,
        bootstrapToolchain: true,
      });
      assert.deepEqual(createRequest?.body?.cache, {
        dependencyCache: true,
      });
      assert.equal(createRequest?.body?.provider, 'cloudflare_workers_assets');
      assert.deepEqual(createRequest?.body?.deploy, {
        outputDir: 'dist',
      });
      assert.deepEqual(createRequest?.body?.provenance, {
        trigger: 'manual_cli',
        taskId: null,
        operationId: null,
        note: null,
        sessionIds: [],
        transcriptUrl: null,
        intentSessionContext: [],
      });
    }

    {
      setWorkspaceDeployIntentContextResolverForTests(async () => {
        throw new Error('Entire-Attribution trailer missing');
      });
      const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body });
        if (
          url.includes('/api/workspaces/ws_abc12345') &&
          !url.endsWith('/deploy/preflight') &&
          !url.endsWith('/deploy') &&
          !url.includes('/deployments/')
        ) {
          return new Response(
            JSON.stringify({
              id: 'ws_abc12345',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: 'a'.repeat(40),
              sourceRef: 'main',
              sourceProjectRoot: '.',
              sourceBundleKey: 'key',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 1,
              sandboxId: 'workspace-ws_abc12345',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              lastDeploymentId: null,
              lastDeploymentStatus: null,
              lastDeployedUrl: null,
              lastDeployedAt: null,
              lastDeploymentErrorCode: null,
              lastDeploymentErrorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_abc12345/events',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy/preflight')) {
          return new Response(
            JSON.stringify({
              preflight: {
                ok: true,
                checks: [{ code: 'workspace_ready', ok: true }],
              },
              nextAction: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in resolver-error test: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () =>
          workspaceDeployCommand('ws_abc12345', {
            idempotencyKey: 'idem-deploy-1',
            runTestsIfPresent: false,
            runBuildIfPresent: false,
          }),
        /Unable to resolve required Entire intent context/
      );
      assert.equal(requests.some((request) => request.url.endsWith('/deploy')), false);

      setWorkspaceDeployIntentContextResolverForTests(async () => ({
        note: 'Review with Entire session intent context (ses_test).',
        sessionIds: ['ses_test'],
        transcriptUrl: null,
        intentSessionContext: ['Do not leak auth tokens.', 'Keep deploy path non-mutating.'],
      }));
    }
  } finally {
    setWorkspaceDeployIntentContextResolverForTests(null);
    globalThis.fetch = originalFetch;
    process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
  }
}
