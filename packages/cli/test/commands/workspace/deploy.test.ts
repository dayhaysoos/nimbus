import { strict as assert } from 'assert';
import {
  parseRepositorySlugFromRemoteUrl,
  setWorkspaceDeployIntentContextResolverForTests,
  setWorkspaceDeployRepositorySlugResolverForTests,
  workspaceDeployCommand,
} from '../../../src/commands/workspace/deploy.js';

export async function runWorkspaceDeployCommandTests(): Promise<void> {
  assert.equal(parseRepositorySlugFromRemoteUrl('https://github.com/dayhaysoos/nimbus.git'), 'dayhaysoos/nimbus');
  assert.equal(parseRepositorySlugFromRemoteUrl('git@github.com:dayhaysoos/nimbus.git'), 'dayhaysoos/nimbus');
  assert.equal(parseRepositorySlugFromRemoteUrl('ssh://git@github.com/dayhaysoos/nimbus.git'), 'dayhaysoos/nimbus');
  assert.equal(parseRepositorySlugFromRemoteUrl('https://gitlab.com/dayhaysoos/nimbus.git'), null);

  const originalFetch = globalThis.fetch;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;
  process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

  try {
    setWorkspaceDeployRepositorySlugResolverForTests(() => 'dayhaysoos/nimbus');
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
          !url.endsWith('/deployments/dep_existing')
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
        rawSessionPrompts: null,
        repo: 'dayhaysoos/nimbus',
        deployProvider: 'cloudflare_workers_assets',
        deployOutputDir: 'dist',
      });
    }

    {
      const requests: Array<{ url: string; body: Record<string, unknown> | null; headers: Headers }> = [];
      let createCount = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body, headers: new Headers(init?.headers) });
        if (
          url.includes('/api/workspaces/ws_abc12345') &&
          !url.endsWith('/deploy/preflight') &&
          !url.endsWith('/deploy') &&
          !url.endsWith('/deployments/dep_new_retry')
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
                checks: [{ code: 'workspace_ready', ok: true }],
                remediations: [],
              },
              nextAction: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy')) {
          createCount += 1;
          if (createCount === 1) {
            return new Response(
              JSON.stringify({
                deployment: {
                  id: 'dep_old_failed',
                  status: 'failed',
                  provider: 'simulated',
                  idempotencyKey: 'idem-deploy-1',
                  maxRetries: 2,
                  attemptCount: 1,
                  sourceSnapshotSha256: null,
                  sourceBundleKey: 'bundle',
                  deployedUrl: null,
                  providerDeploymentId: null,
                  cancelRequestedAt: null,
                  startedAt: '2026-03-11T00:00:00.000Z',
                  finishedAt: '2026-03-11T00:00:30.000Z',
                  createdAt: '2026-03-11T00:00:00.000Z',
                  updatedAt: '2026-03-11T00:00:30.000Z',
                  provenance: {},
                  toolchain: null,
                  dependencyCacheKey: null,
                  dependencyCacheHit: false,
                  remediations: [],
                },
                reused: true,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              deployment: {
                id: 'dep_new_retry',
                status: 'queued',
                provider: 'simulated',
              },
              reused: false,
            }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deployments/dep_new_retry')) {
          return new Response(
            JSON.stringify({ deployment: { id: 'dep_new_retry', status: 'succeeded', provider: 'simulated', deployedUrl: 'https://example.dev' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in failed-reuse retry test: ${url}`);
      }) as typeof fetch;

      const deployment = await workspaceDeployCommand('ws_abc12345', {
        idempotencyKey: 'idem-deploy-1',
        runTestsIfPresent: false,
        runBuildIfPresent: false,
        pollIntervalMs: 1,
      });

      assert.equal(deployment?.id, 'dep_new_retry');
      const deployRequests = requests.filter((request) => request.url.endsWith('/deploy'));
      assert.equal(deployRequests.length, 2);
      assert.equal(deployRequests[0].headers.get('Idempotency-Key'), 'idem-deploy-1');
      assert.notEqual(deployRequests[1].headers.get('Idempotency-Key'), 'idem-deploy-1');
    }

    {
      const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      let preflightAttempts = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        requests.push({ url, body });
        if (
          url.includes('/api/workspaces/ws_abc12345') &&
          !url.endsWith('/deploy/preflight') &&
          !url.endsWith('/deploy') &&
          !url.endsWith('/reset') &&
          !url.endsWith('/deployments/dep_after_reset')
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
          preflightAttempts += 1;
          if (preflightAttempts === 1) {
            return new Response(
              JSON.stringify({
                preflight: {
                  ok: false,
                  checks: [
                    { code: 'workspace_ready', ok: true },
                    { code: 'git_baseline', ok: false, details: 'Workspace git baseline is missing' },
                  ],
                  remediations: [{ code: 'baseline_rehydrated', applied: false, details: 'auto-fix failed' }],
                },
                nextAction: 'Reset workspace to rebuild git baseline and retry deploy.',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(
            JSON.stringify({
              preflight: {
                ok: true,
                checks: [
                  { code: 'workspace_ready', ok: true },
                  { code: 'git_baseline', ok: true, details: 'auto-fixed baseline rehydrate' },
                ],
                remediations: [{ code: 'baseline_rehydrated', applied: true }],
              },
              nextAction: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/reset') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              workspace: {
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
                updatedAt: '2026-03-11T00:01:00.000Z',
                deletedAt: null,
                eventsUrl: '/api/workspaces/ws_abc12345/events',
              },
              warning: 'post-reset cleanup warning',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deploy')) {
          return new Response(
            JSON.stringify({ deployment: { id: 'dep_after_reset', status: 'queued' } }),
            { status: 202, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deployments/dep_after_reset')) {
          return new Response(
            JSON.stringify({ deployment: { id: 'dep_after_reset', status: 'succeeded', provider: 'simulated', deployedUrl: 'https://example.dev' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in reset-retry test: ${url}`);
      }) as typeof fetch;

      const deployment = await workspaceDeployCommand('ws_abc12345', {
        idempotencyKey: 'idem-deploy-reset',
        runTestsIfPresent: false,
        runBuildIfPresent: false,
        autoFix: true,
        pollIntervalMs: 1,
      });

      assert.equal(deployment?.id, 'dep_after_reset');
      assert.equal(requests.filter((request) => request.url.endsWith('/deploy/preflight')).length, 2);
      assert.equal(requests.some((request) => request.url.endsWith('/reset')), true);
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
              lastDeploymentId: 'dep_existing',
              lastDeploymentStatus: 'succeeded',
              lastDeployedUrl: 'https://example.dev',
              lastDeployedAt: '2026-03-11T00:00:00.000Z',
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
                ok: false,
                checks: [
                  { code: 'workspace_ready', ok: true },
                  { code: 'git_baseline', ok: false, details: 'Workspace git baseline is missing' },
                ],
                remediations: [],
              },
              nextAction: 'Reset workspace to rebuild git baseline and retry deploy.',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deployments/dep_existing')) {
          return new Response(
            JSON.stringify({
              deployment: {
                id: 'dep_existing',
                status: 'succeeded',
                provider: 'simulated',
                idempotencyKey: 'idem-deploy-1',
                maxRetries: 2,
                attemptCount: 1,
                sourceSnapshotSha256: null,
                sourceBundleKey: 'bundle',
                deployedUrl: 'https://example.dev',
                providerDeploymentId: null,
                cancelRequestedAt: null,
                startedAt: '2026-03-11T00:00:00.000Z',
                finishedAt: '2026-03-11T00:00:30.000Z',
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:30.000Z',
                provenance: {},
                toolchain: null,
                dependencyCacheKey: null,
                dependencyCacheHit: false,
                remediations: [],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in reuse-fallback test: ${url}`);
      }) as typeof fetch;

      const deployment = await workspaceDeployCommand('ws_abc12345', {
        idempotencyKey: 'idem-deploy-1',
        runTestsIfPresent: false,
        runBuildIfPresent: false,
      });

      assert.equal(deployment?.id, 'dep_existing');
      const createRequest = requests.find((request) => request.url.endsWith('/deploy'));
      assert.equal(createRequest, undefined);
      assert.equal(requests.some((request) => request.url.endsWith('/deployments/dep_existing')), true);
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
          !url.endsWith('/deployments/dep_existing')
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
              lastDeploymentId: 'dep_existing',
              lastDeploymentStatus: 'succeeded',
              lastDeployedUrl: 'https://example.dev',
              lastDeployedAt: '2026-03-11T00:00:00.000Z',
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
                ok: false,
                checks: [
                  { code: 'workspace_ready', ok: true },
                  { code: 'git_baseline', ok: false, details: 'Workspace git baseline is missing' },
                ],
                remediations: [],
              },
              nextAction: 'Reset workspace to rebuild git baseline and retry deploy.',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/deployments/dep_existing')) {
          return new Response(
            JSON.stringify({
              deployment: {
                id: 'dep_existing',
                status: 'succeeded',
                provider: 'simulated',
                idempotencyKey: 'idem-deploy-1',
                maxRetries: 2,
                attemptCount: 1,
                sourceSnapshotSha256: null,
                sourceBundleKey: 'bundle',
                deployedUrl: 'https://example.dev',
                providerDeploymentId: null,
                cancelRequestedAt: null,
                startedAt: '2026-03-11T00:00:00.000Z',
                finishedAt: '2026-03-11T00:00:30.000Z',
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:30.000Z',
                provenance: {},
                toolchain: null,
                dependencyCacheKey: null,
                dependencyCacheHit: false,
                remediations: [],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in provider-mismatch fallback test: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () =>
          workspaceDeployCommand('ws_abc12345', {
            idempotencyKey: 'idem-deploy-1',
            runTestsIfPresent: false,
            runBuildIfPresent: false,
            provider: 'cloudflare_workers_assets',
          }),
        /Workspace deploy preflight failed/
      );

      const createRequest = requests.find((request) => request.url.endsWith('/deploy'));
      assert.equal(createRequest, undefined);
      assert.equal(requests.some((request) => request.url.endsWith('/deployments/dep_existing')), true);
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
                ok: false,
                checks: [
                  { code: 'workspace_ready', ok: true },
                  { code: 'git_baseline', ok: false, details: 'Workspace git baseline is missing' },
                ],
                remediations: [],
              },
              nextAction: 'Reset workspace to rebuild git baseline and retry deploy.',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        throw new Error(`Unexpected request in no-existing-deploy fallback test: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () =>
          workspaceDeployCommand('ws_abc12345', {
            idempotencyKey: 'idem-deploy-1',
            runTestsIfPresent: false,
            runBuildIfPresent: false,
          }),
        /Workspace deploy preflight failed/
      );

      const createRequest = requests.find((request) => request.url.endsWith('/deploy'));
      assert.equal(createRequest, undefined);
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
    setWorkspaceDeployRepositorySlugResolverForTests(null);
    globalThis.fetch = originalFetch;
    process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
  }
}
