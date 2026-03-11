import { strict as assert } from 'assert';
import {
  createWorkspaceDeployProvider,
  getWorkspaceDeployProviderConfigError,
  getWorkspaceDeployProviderName,
  normalizeProviderError,
  setWorkspaceDeployProviderFetchForTests,
} from './workspace-deploy-provider.js';

const sampleOutputFiles = [
  {
    path: 'index.html',
    bytes: new Uint8Array([1, 2, 3]),
    sha256: 'abc',
  },
];

export async function runWorkspaceDeployProviderTests(): Promise<void> {
  {
    const provider = createWorkspaceDeployProvider('simulated', {} as never);
    const checks = await provider.precheck();
    assert.equal(checks.length > 0, true);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      outputDir: 'dist',
      outputFiles: sampleOutputFiles,
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.status, 'succeeded');
  }

  {
    const resolved = getWorkspaceDeployProviderName(undefined, { WORKSPACE_DEPLOY_PROVIDER: 'cloudflare_workers_assets' } as never);
    assert.equal(resolved, 'cloudflare_workers_assets');
  }

  {
    const resolved = getWorkspaceDeployProviderName(undefined, {
      WORKSPACE_DEPLOY_PROVIDER: ' cloudflare_workers_assets ',
    } as never);
    assert.equal(resolved, 'cloudflare_workers_assets');
  }

  {
    const resolved = getWorkspaceDeployProviderName(' cloudflare_workers_assets ', {
      WORKSPACE_DEPLOY_PROVIDER: 'simulated',
    } as never);
    assert.equal(resolved, 'cloudflare_workers_assets');
  }

  {
    const error = getWorkspaceDeployProviderConfigError({ WORKSPACE_DEPLOY_PROVIDER: 'cloudflare-workers-assets' } as never);
    assert.equal(typeof error, 'string');
  }

  {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    setWorkspaceDeployProviderFetchForTests(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown>;
      if (init?.body instanceof FormData) {
        body = {};
        for (const [key, value] of init.body.entries()) {
          body[key] = value;
        }
      } else {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      }
      calls.push({ url, body });
      if (url.endsWith('/workers/scripts/project/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['abc00000000000000000000000000000']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/project/versions')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'version_123' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/project/deployments')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_123' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      outputDir: 'dist',
      outputFiles: sampleOutputFiles,
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.providerDeploymentId, 'deployment:cfdep_123:dep_abcd1234:%2F');
    assert.equal(calls.length, 4);
    assert.equal(Object.values(calls[1].body).includes('AQID'), true);
    assert.equal(typeof calls[2].body.metadata, 'string');
    const versionMetadata = JSON.parse(String(calls[2].body.metadata)) as Record<string, unknown>;
    const annotations = versionMetadata.annotations as Record<string, unknown>;
    assert.equal(annotations['workers/alias'], 'dep-dep-abcd1234');
    assert.equal(calls[3].body.strategy, 'percentage');
    assert.equal(created.deployedUrl, null);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['abc00000000000000000000000000000']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/project/versions')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'version_123' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/project/deployments')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_123' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      outputDir: 'dist..backup',
      outputFiles: sampleOutputFiles,
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.providerDeploymentId, 'deployment:cfdep_123:dep_abcd1234:%2F');
  }

  {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    setWorkspaceDeployProviderFetchForTests(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown>;
      if (init?.body instanceof FormData) {
        body = {};
        for (const [key, value] of init.body.entries()) {
          body[key] = value;
        }
      } else {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      }
      calls.push({ url, body });
      if (url.endsWith('/workers/scripts/project/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['abc00000000000000000000000000000']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/project/versions')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'version_123' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/project/deployments')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'cfdep_123' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd_1234',
      outputDir: 'dist',
      outputFiles: sampleOutputFiles,
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(typeof calls[2].body.metadata, 'string');
    assert.equal(calls[3].body.strategy, 'percentage');
    assert.equal(created.deployedUrl, null);
  }

  {
    const calls: Array<{ url: string; method: string }> = [];
    setWorkspaceDeployProviderFetchForTests(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: String(init?.method ?? 'GET') });
      if (url.endsWith('/workers/scripts/project/assets-upload-session')) {
        return new Response(
          JSON.stringify({ success: true, result: { jwt: 'upload_jwt_123', buckets: [['abc00000000000000000000000000000']] } }),
          { status: 200 }
        );
      }
      if (url.endsWith('/workers/assets/upload?base64=true')) {
        return new Response(JSON.stringify({ success: true, jwt: 'completion_jwt_123' }), { status: 201 });
      }
      if (url.endsWith('/workers/scripts/project/versions')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'version_123' } }), { status: 200 });
      }
      if (url.endsWith('/workers/scripts/project/deployments')) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: 'Invalid deployment: The value "[]" is invalid for field "versions"' }] }),
          { status: 400 }
        );
      }
      if (url.endsWith('/workers/scripts/project')) {
        return new Response(JSON.stringify({ success: true, result: { id: 'script_update_123' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      outputDir: 'dist',
      outputFiles: sampleOutputFiles,
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.providerDeploymentId, 'script-update:dep_abcd1234');
    assert.equal(created.status, 'running');
    assert.equal(created.deployedUrl, null);
    assert.equal(calls.some((call) => call.url.endsWith('/workers/scripts/project') && call.method === 'PUT'), true);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://dep-dep-abcd1234.preview.example.com') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('script-update:dep_abcd1234');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.deployedUrl, 'https://dep-dep-abcd1234.preview.example.com');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://dep-dep-abcd1234-project.example.workers.dev') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'example.workers.dev',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('script-update:dep_abcd1234');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.deployedUrl, 'https://dep-dep-abcd1234-project.example.workers.dev');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url === 'https://dep-dep-missing.preview.example.com') {
        return new Response('not found', { status: 404 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('script-update:dep_missing');
    assert.equal(status.status, 'failed');
    assert.equal(status.errorCode, 'provider_deploy_failed');
    assert.equal(status.deployedUrl, null);
  }

  {
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('script_update_123');
    assert.equal(status.status, 'failed');
    assert.equal(status.errorCode, 'provider_deploy_failed');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_123')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'running' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('cfdep_123');
    assert.equal(status.deployedUrl, null);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_404')) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), { status: 404 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('cfdep_404');
    assert.equal(status.status, 'running');
    assert.equal(status.deployedUrl, null);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_legacy')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'succeeded' } }), { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('cfdep_legacy');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.deployedUrl, null);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_456')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'succeeded' } }), { status: 200 });
      }
      if (url === 'https://dep-dep-live.preview.example.com') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('deployment:cfdep_456:dep_live');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.deployedUrl, 'https://dep-dep-live.preview.example.com');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_space')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'succeeded' } }), { status: 200 });
      }
      if (url === 'https://dep-dep-space.preview.example.com/my%20file.txt') {
        return new Response('ok', { status: 200 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('deployment:cfdep_space:dep_space:%2Fmy%20file.txt');
    assert.equal(status.status, 'succeeded');
    assert.equal(status.deployedUrl, 'https://dep-dep-space.preview.example.com/my%20file.txt');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_unreachable')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'succeeded' } }), { status: 200 });
      }
      if (url === 'https://dep-dep-unreachable.preview.example.com') {
        return new Response('missing', { status: 404 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('deployment:cfdep_unreachable:dep_unreachable');
    assert.equal(status.status, 'running');
    assert.equal(status.errorCode, 'provider_probe_missing');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_propagating')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'running' } }), { status: 200 });
      }
      if (url === 'https://dep-dep-propagating.preview.example.com') {
        return new Response('missing', { status: 404 });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('deployment:cfdep_propagating:dep_propagating');
    assert.equal(status.status, 'running');
    assert.equal(status.deployedUrl, null);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/workers/scripts/project/deployments/cfdep_unknown')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'succeeded' } }), { status: 200 });
      }
      if (url === 'https://dep-dep-unknown.preview.example.com') {
        throw new Error('network timeout');
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const status = await provider.getDeploymentStatus('deployment:cfdep_unknown:dep_unknown');
    assert.equal(status.status, 'running');
    assert.equal(status.deployedUrl, null);
    assert.equal(status.errorCode, 'provider_probe_unknown');
  }

  {
    setWorkspaceDeployProviderFetchForTests(async () =>
      new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    );
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    const checks = await provider.precheck();
    assert.equal(checks.every((check) => check.ok), true);
  }

  {
    setWorkspaceDeployProviderFetchForTests(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'invalid request' }] }), { status: 200 })
    );
    const provider = createWorkspaceDeployProvider('cloudflare_workers_assets', {
      CF_ACCOUNT_ID: 'acc',
      CF_API_TOKEN: 'token',
      WORKSPACE_DEPLOY_PREVIEW_DOMAIN: 'preview.example.com',
      WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
      WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
    } as never);
    await assert.rejects(provider.precheck(), /invalid request/);
  }

  {
    assert.throws(
      () =>
        createWorkspaceDeployProvider('cloudflare_workers_assets', {
          CF_ACCOUNT_ID: 'acc',
          CF_API_TOKEN: 'token',
          WORKSPACE_DEPLOY_PROJECT_NAME: 'project',
          WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED: 'true',
        } as never),
      /WORKSPACE_DEPLOY_PREVIEW_DOMAIN/
    );
  }

  {
    const normalized = normalizeProviderError(new Error('boom'));
    assert.equal(normalized.code, 'provider_deploy_failed');
  }

  setWorkspaceDeployProviderFetchForTests(null);
}
