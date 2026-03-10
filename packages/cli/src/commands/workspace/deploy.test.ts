import { strict as assert } from 'assert';
import { workspaceDeployCommand } from './deploy.js';

export async function runWorkspaceDeployCommandTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;
  process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

  try {
    {
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
    }

    {
      const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body });
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
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
  }
}
