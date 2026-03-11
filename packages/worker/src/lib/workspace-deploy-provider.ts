import type { Env, WorkspaceDeploymentStatus } from '../types.js';

export type WorkspaceDeployProviderName = 'simulated' | 'cloudflare_workers_assets';

export interface WorkspaceDeployProviderPrecheck {
  code: string;
  ok: boolean;
  details?: string;
}

export interface WorkspaceDeployCreateInput {
  workspaceId: string;
  deploymentId: string;
  outputDir: string;
  outputBundle: {
    bytes: Uint8Array;
    sha256: string;
  };
}

export interface WorkspaceDeployCreateResult {
  providerDeploymentId: string;
  status: WorkspaceDeploymentStatus;
  deployedUrl: string | null;
}

export interface WorkspaceDeployStatusResult {
  status: WorkspaceDeploymentStatus;
  deployedUrl: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface WorkspaceDeployProvider {
  readonly name: WorkspaceDeployProviderName;
  precheck(): Promise<WorkspaceDeployProviderPrecheck[]>;
  createDeployment(input: WorkspaceDeployCreateInput): Promise<WorkspaceDeployCreateResult>;
  getDeploymentStatus(providerDeploymentId: string): Promise<WorkspaceDeployStatusResult>;
  cancelDeployment(providerDeploymentId: string): Promise<{ accepted: boolean }>;
}

class ProviderError extends Error {
  constructor(
    public readonly code:
      | 'provider_auth_failed'
      | 'provider_rate_limited'
      | 'provider_project_not_found'
      | 'provider_deploy_failed'
      | 'provider_invalid_output_dir'
      | 'provider_scope_missing',
    message: string
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

type ProviderFetch = typeof fetch;

let providerFetch: ProviderFetch = fetch;

export function setWorkspaceDeployProviderFetchForTests(fetchImpl: ProviderFetch | null): void {
  providerFetch = fetchImpl ?? fetch;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function requireEnv(
  value: string | undefined,
  key: string,
  code: 'provider_auth_failed' | 'provider_scope_missing' | 'provider_deploy_failed' = 'provider_auth_failed'
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderError(code, `Missing required provider env: ${key}`);
  }
  return value.trim();
}

function cloudflareErrorsMessage(input: unknown): string | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const messages = input
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message.trim()) {
        return record.message.trim();
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
  if (messages.length === 0) {
    return null;
  }
  return messages.join('; ');
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >> 18) & 63] ?? '';
    output += alphabet[(value >> 12) & 63] ?? '';
    output += index + 1 < bytes.length ? alphabet[(value >> 6) & 63] ?? '' : '=';
    output += index + 2 < bytes.length ? alphabet[value & 63] ?? '' : '=';
  }
  return output;
}

function isValidRelativeOutputDir(value: string): boolean {
  if (!value || value === '.') {
    return false;
  }
  if (value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return value.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function mapProviderState(input: string): WorkspaceDeploymentStatus {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'queued' || normalized === 'pending') {
    return 'queued';
  }
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'processing') {
    return 'running';
  }
  if (normalized === 'succeeded' || normalized === 'success' || normalized === 'completed' || normalized === 'active') {
    return 'succeeded';
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'cancelled';
  }
  return 'failed';
}

function dnsSafeLabel(input: string): string {
  const lowered = input.trim().toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return replaced || 'deployment';
}

class SimulatedWorkspaceDeployProvider implements WorkspaceDeployProvider {
  readonly name = 'simulated' as const;

  constructor(private readonly env: Env) {}

  async precheck(): Promise<WorkspaceDeployProviderPrecheck[]> {
    return [{ code: 'provider_simulated', ok: true, details: 'simulated provider selected' }];
  }

  async createDeployment(input: WorkspaceDeployCreateInput): Promise<WorkspaceDeployCreateResult> {
    const deployBase = (this.env.WORKSPACE_DEPLOY_BASE_URL ?? 'https://deployments.nimbus.local').replace(/\/+$/, '');
    return {
      providerDeploymentId: input.deploymentId,
      status: 'succeeded',
      deployedUrl: `${deployBase}/${input.workspaceId}/${input.deploymentId}`,
    };
  }

  async getDeploymentStatus(_providerDeploymentId: string): Promise<WorkspaceDeployStatusResult> {
    return { status: 'succeeded', deployedUrl: null };
  }

  async cancelDeployment(_providerDeploymentId: string): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

class CloudflareWorkersAssetsProvider implements WorkspaceDeployProvider {
  readonly name = 'cloudflare_workers_assets' as const;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly previewDomain: string;
  private readonly projectName: string;

  constructor(private readonly env: Env) {
    this.accountId = requireEnv(env.CF_ACCOUNT_ID, 'CF_ACCOUNT_ID');
    this.apiToken = requireEnv(env.CF_API_TOKEN, 'CF_API_TOKEN');
    this.previewDomain = requireEnv(
      env.WORKSPACE_DEPLOY_PREVIEW_DOMAIN,
      'WORKSPACE_DEPLOY_PREVIEW_DOMAIN',
      'provider_deploy_failed'
    );
    this.projectName = requireEnv(
      env.WORKSPACE_DEPLOY_PROJECT_NAME,
      'WORKSPACE_DEPLOY_PROJECT_NAME',
      'provider_deploy_failed'
    );

    if (!parseBoolean(env.WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED, false)) {
      throw new ProviderError(
        'provider_deploy_failed',
        'Real deploy provider is disabled; set WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED=true to enable'
      );
    }
  }

  private request(path: string, init?: RequestInit, authToken?: string): Promise<Response> {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${authToken ?? this.apiToken}`);
    }
    if (!headers.has('Content-Type') && !(init?.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    return providerFetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers,
    });
  }

  private async parseCloudflareResult(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }

    if (response.status === 401) {
      throw new ProviderError('provider_auth_failed', 'Cloudflare API token is invalid');
    }
    if (response.status === 403) {
      throw new ProviderError('provider_scope_missing', 'Cloudflare API token is missing required scopes');
    }
    if (response.status === 404) {
      throw new ProviderError('provider_project_not_found', `Cloudflare project ${this.projectName} was not found`);
    }
    if (response.status === 429) {
      throw new ProviderError('provider_rate_limited', 'Cloudflare API rate limit exceeded');
    }
    if (!response.ok) {
      const errorMessage =
        cloudflareErrorsMessage(parsed.errors) ??
        (typeof parsed.errors === 'object' && parsed.errors !== null
          ? JSON.stringify(parsed.errors)
          : text || `Cloudflare API request failed with status ${response.status}`);
      throw new ProviderError('provider_deploy_failed', errorMessage);
    }

    if (parsed.success === false) {
      const errorMessage =
        cloudflareErrorsMessage(parsed.errors) ??
        `Cloudflare API reported success=false${response.status ? ` (status ${response.status})` : ''}`;
      throw new ProviderError('provider_deploy_failed', errorMessage);
    }

    return parsed;
  }

  private previewUrlForDeployment(deploymentId: string): string {
    return `https://dep-${dnsSafeLabel(deploymentId)}.${this.previewDomain}`;
  }

  private static readonly assetsMainModule = 'nimbus-assets-entry.mjs';
  private static readonly scriptUpdateDeploymentPrefix = 'script-update:';

  private static assetsWorkerSource(): string {
    return 'export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };';
  }

  private static scriptUpdateProviderDeploymentId(deploymentId: string): string {
    return `${CloudflareWorkersAssetsProvider.scriptUpdateDeploymentPrefix}${deploymentId}`;
  }

  private static deploymentIdFromScriptUpdateProviderId(providerDeploymentId: string): string | null {
    if (!providerDeploymentId.startsWith(CloudflareWorkersAssetsProvider.scriptUpdateDeploymentPrefix)) {
      return null;
    }
    const value = providerDeploymentId.slice(CloudflareWorkersAssetsProvider.scriptUpdateDeploymentPrefix.length).trim();
    return value ? value : null;
  }

  private async probePreviewUrl(url: string): Promise<'reachable' | 'missing' | 'unknown'> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('preview_url_probe_timeout'), 2_000);
    try {
      const response = await providerFetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 200 && response.status < 400) {
        return 'reachable';
      }
      if (response.status === 404) {
        return 'missing';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timeout);
    }
  }

  private static toManifestHash(sha256: string): string {
    const normalized = sha256.trim().toLowerCase();
    const hex = normalized.replace(/[^a-f0-9]/g, '');
    return (hex.slice(0, 32) || '0'.repeat(32)).padEnd(32, '0');
  }

  private static completionJwtFromUploadResponse(parsed: Record<string, unknown>): string | null {
    const topLevel = typeof parsed.jwt === 'string' && parsed.jwt.trim() ? parsed.jwt.trim() : null;
    if (topLevel) {
      return topLevel;
    }
    if (typeof parsed.result === 'object' && parsed.result !== null) {
      const resultJwt = (parsed.result as Record<string, unknown>).jwt;
      if (typeof resultJwt === 'string' && resultJwt.trim()) {
        return resultJwt.trim();
      }
    }
    return null;
  }

  private async deployScriptWithAssetsJwt(completionJwt: string): Promise<Record<string, unknown>> {
    const metadata = {
      main_module: CloudflareWorkersAssetsProvider.assetsMainModule,
      compatibility_date: new Date().toISOString().slice(0, 10),
      assets: {
        jwt: completionJwt,
      },
      bindings: [
        {
          name: 'ASSETS',
          type: 'assets',
        },
      ],
    };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append(
      CloudflareWorkersAssetsProvider.assetsMainModule,
      new Blob([CloudflareWorkersAssetsProvider.assetsWorkerSource()], {
        type: 'application/javascript+module',
      }),
      CloudflareWorkersAssetsProvider.assetsMainModule
    );

    const response = await this.request(`/accounts/${this.accountId}/workers/scripts/${this.projectName}`, {
      method: 'PUT',
      body: form,
    });
    return this.parseCloudflareResult(response);
  }

  async precheck(): Promise<WorkspaceDeployProviderPrecheck[]> {
    const checks: WorkspaceDeployProviderPrecheck[] = [];
    checks.push({ code: 'provider_real_enabled', ok: true });
    checks.push({ code: 'provider_credentials_present', ok: true });

    const response = await this.request(`/accounts/${this.accountId}/workers/scripts/${this.projectName}`);
    await this.parseCloudflareResult(response);
    checks.push({ code: 'provider_project_access', ok: true });
    return checks;
  }

  async createDeployment(input: WorkspaceDeployCreateInput): Promise<WorkspaceDeployCreateResult> {
    if (!isValidRelativeOutputDir(input.outputDir)) {
      throw new ProviderError(
        'provider_invalid_output_dir',
        'deploy.outputDir must be a safe non-root relative directory path'
      );
    }

    const assetPath = `/__nimbus/${dnsSafeLabel(input.deploymentId)}.tar.gz`;
    const manifestHash = CloudflareWorkersAssetsProvider.toManifestHash(input.outputBundle.sha256);
    const sessionResponse = await this.request(
      `/accounts/${this.accountId}/workers/scripts/${this.projectName}/assets-upload-session`,
      {
        method: 'POST',
        body: JSON.stringify({
          manifest: {
            [assetPath]: {
              hash: manifestHash,
              size: input.outputBundle.bytes.byteLength,
            },
          },
        }),
      }
    );
    const sessionParsed = await this.parseCloudflareResult(sessionResponse);
    const sessionResult =
      typeof sessionParsed.result === 'object' && sessionParsed.result !== null
        ? (sessionParsed.result as Record<string, unknown>)
        : {};
    const uploadJwt =
      typeof sessionResult.jwt === 'string' && sessionResult.jwt.trim() ? sessionResult.jwt.trim() : null;
    if (!uploadJwt) {
      throw new ProviderError('provider_deploy_failed', 'Cloudflare asset upload session did not return a JWT');
    }

    const bucketSets = Array.isArray(sessionResult.buckets) ? sessionResult.buckets : [];
    const shouldUpload = bucketSets.some((bucket) => Array.isArray(bucket) && bucket.some((value) => value === manifestHash));

    let uploadParsed: Record<string, unknown> | null = null;
    if (shouldUpload) {
      const uploadForm = new FormData();
      uploadForm.append(manifestHash, toBase64(input.outputBundle.bytes));
      const uploadResponse = await this.request(
        `/accounts/${this.accountId}/workers/assets/upload?base64=true`,
        {
          method: 'POST',
          body: uploadForm,
        },
        uploadJwt
      );
      uploadParsed = await this.parseCloudflareResult(uploadResponse);
    }

    const completionJwt =
      (uploadParsed ? CloudflareWorkersAssetsProvider.completionJwtFromUploadResponse(uploadParsed) : null) ??
      CloudflareWorkersAssetsProvider.completionJwtFromUploadResponse(sessionParsed);
    if (!completionJwt) {
      throw new ProviderError('provider_deploy_failed', 'Cloudflare asset upload did not return a completion JWT');
    }

    let parsed: Record<string, unknown>;
    let createStatus: WorkspaceDeploymentStatus = 'running';
    let fallbackScriptUpdate = false;
    try {
      const response = await this.request(`/accounts/${this.accountId}/workers/scripts/${this.projectName}/deployments`, {
        method: 'POST',
        body: JSON.stringify({
          deployment_id: input.deploymentId,
          alias: `dep-${dnsSafeLabel(input.deploymentId)}`,
          output_dir: input.outputDir,
          assets: {
            jwt: completionJwt,
            manifest: {
              [assetPath]: {
                hash: manifestHash,
                size: input.outputBundle.bytes.byteLength,
              },
            },
          },
          preview_url: this.previewUrlForDeployment(input.deploymentId),
        }),
      });
      parsed = await this.parseCloudflareResult(response);
    } catch (error) {
      const providerError = normalizeProviderError(error);
      if (
        providerError.code === 'provider_deploy_failed' &&
        providerError.message.toLowerCase().includes('invalid for field "versions"')
      ) {
        parsed = await this.deployScriptWithAssetsJwt(completionJwt);
        fallbackScriptUpdate = true;
      } else {
        throw error;
      }
    }
    const result =
      typeof parsed.result === 'object' && parsed.result !== null ? (parsed.result as Record<string, unknown>) : {};
    const providerDeploymentId = fallbackScriptUpdate
      ? CloudflareWorkersAssetsProvider.scriptUpdateProviderDeploymentId(input.deploymentId)
      : typeof result.id === 'string' && result.id.trim()
        ? result.id.trim()
        : `cfdep_${input.deploymentId}`;

    return {
      providerDeploymentId,
      status: createStatus,
      deployedUrl: fallbackScriptUpdate ? null : this.previewUrlForDeployment(input.deploymentId),
    };
  }

  async getDeploymentStatus(providerDeploymentId: string): Promise<WorkspaceDeployStatusResult> {
    const scriptUpdateDeploymentId = CloudflareWorkersAssetsProvider.deploymentIdFromScriptUpdateProviderId(providerDeploymentId);
    if (scriptUpdateDeploymentId) {
      const url = this.previewUrlForDeployment(scriptUpdateDeploymentId);
      const probe = await this.probePreviewUrl(url);
      if (probe === 'reachable') {
        return {
          status: 'succeeded',
          deployedUrl: url,
        };
      }
      if (probe === 'missing') {
        return {
          status: 'failed',
          deployedUrl: null,
          errorCode: 'provider_deploy_failed',
          errorMessage: 'Fallback script update succeeded but preview URL alias is not reachable',
        };
      }
      return {
        status: 'running',
        deployedUrl: null,
      };
    }
    if (providerDeploymentId.startsWith('script_update_')) {
      return {
        status: 'failed',
        deployedUrl: null,
        errorCode: 'provider_deploy_failed',
        errorMessage: 'Legacy script update provider deployment IDs are not resumable',
      };
    }

    const response = await this.request(
      `/accounts/${this.accountId}/workers/scripts/${this.projectName}/deployments/${providerDeploymentId}`
    );

    if (response.status === 404) {
      return {
        status: 'running',
        deployedUrl: null,
      };
    }

    const parsed = await this.parseCloudflareResult(response);
    const result =
      typeof parsed.result === 'object' && parsed.result !== null ? (parsed.result as Record<string, unknown>) : {};
    const hasVersions = Array.isArray(result.versions) && result.versions.length > 0;
    let state: WorkspaceDeploymentStatus;
    if (typeof result.status === 'string') {
      const mapped = mapProviderState(result.status);
      state = mapped === 'running' && hasVersions ? 'succeeded' : mapped;
    } else {
      state = hasVersions ? 'succeeded' : 'running';
    }
    return {
      status: state,
      deployedUrl: typeof result.preview_url === 'string' && result.preview_url.trim() ? result.preview_url : null,
      errorCode: typeof result.error_code === 'string' ? result.error_code : undefined,
      errorMessage: typeof result.error_message === 'string' ? result.error_message : undefined,
    };
  }

  async cancelDeployment(providerDeploymentId: string): Promise<{ accepted: boolean }> {
    if (CloudflareWorkersAssetsProvider.deploymentIdFromScriptUpdateProviderId(providerDeploymentId)) {
      return { accepted: false };
    }
    if (providerDeploymentId.startsWith('script_update_')) {
      return { accepted: false };
    }

    const response = await this.request(
      `/accounts/${this.accountId}/workers/scripts/${this.projectName}/deployments/${providerDeploymentId}/cancel`,
      { method: 'POST', body: '{}' }
    );

    if (response.status === 404 || response.status === 409) {
      return { accepted: false };
    }

    await this.parseCloudflareResult(response);
    return { accepted: true };
  }
}

export function getWorkspaceDeployProviderName(input: unknown, env: Env): WorkspaceDeployProviderName {
  if (typeof input === 'string' && input.trim()) {
    const normalizedInput = input.trim();
    if (normalizedInput === 'simulated' || normalizedInput === 'cloudflare_workers_assets') {
      return normalizedInput;
    }
  }

  const configured = typeof env.WORKSPACE_DEPLOY_PROVIDER === 'string' ? env.WORKSPACE_DEPLOY_PROVIDER.trim() : '';
  if (configured === 'cloudflare_workers_assets') {
    return 'cloudflare_workers_assets';
  }

  return 'simulated';
}

export function getWorkspaceDeployProviderConfigError(env: Env): string | null {
  const configured = typeof env.WORKSPACE_DEPLOY_PROVIDER === 'string' ? env.WORKSPACE_DEPLOY_PROVIDER.trim() : '';
  if (!configured || configured === 'simulated' || configured === 'cloudflare_workers_assets') {
    return null;
  }
  return `Invalid WORKSPACE_DEPLOY_PROVIDER value: ${configured}. Use simulated or cloudflare_workers_assets.`;
}

export function createWorkspaceDeployProvider(providerName: WorkspaceDeployProviderName, env: Env): WorkspaceDeployProvider {
  if (providerName === 'cloudflare_workers_assets') {
    return new CloudflareWorkersAssetsProvider(env);
  }
  return new SimulatedWorkspaceDeployProvider(env);
}

export function normalizeProviderError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof Error) {
    return { code: 'provider_deploy_failed', message: error.message };
  }

  return { code: 'provider_deploy_failed', message: String(error) };
}
