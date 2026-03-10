import { strict as assert } from 'assert';
import {
  createWorkspaceDeployProvider,
  getWorkspaceDeployProviderConfigError,
  getWorkspaceDeployProviderName,
  normalizeProviderError,
  setWorkspaceDeployProviderFetchForTests,
} from './workspace-deploy-provider.js';

export async function runWorkspaceDeployProviderTests(): Promise<void> {
  {
    const provider = createWorkspaceDeployProvider('simulated', {} as never);
    const checks = await provider.precheck();
    assert.equal(checks.length > 0, true);
    const created = await provider.createDeployment({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      outputDir: 'dist',
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
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.providerDeploymentId, 'cfdep_123');
    assert.equal(calls.length, 3);
    assert.equal(Object.values(calls[1].body).includes('AQID'), true);
    assert.equal(typeof calls[2].body.assets, 'object');
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
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(created.providerDeploymentId, 'cfdep_123');
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
      outputBundle: { bytes: new Uint8Array([1, 2, 3]), sha256: 'abc' },
    });
    assert.equal(calls[2].body.alias, 'dep-dep-abcd-1234');
    assert.equal(calls[2].body.preview_url, 'https://dep-dep-abcd-1234.preview.example.com');
    assert.equal(created.deployedUrl, 'https://dep-dep-abcd-1234.preview.example.com');
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
