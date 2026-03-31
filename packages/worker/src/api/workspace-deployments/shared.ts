import type { AuthContext, Env } from '../../types.js';
import { loadRuntimeFlags } from '../../lib/flags.js';
import { getWorkspace, getWorkspaceAccountId } from '../../lib/db.js';
import { canAccessAccount } from '../../lib/authz.js';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Nimbus-Api-Key',
};

export const PROVIDER_PRECHECK_LEASE_MS = 30_000;
export const MAX_PROVENANCE_SESSION_ID_LENGTH = 160;
export const MAX_PROVENANCE_INTENT_CONTEXT_LENGTH = 800;
export const MAX_PROVENANCE_REPO_LENGTH = 256;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function deploymentCreateResponseStatus(reused: boolean): number {
  return reused ? 200 : 202;
}

export function parseInteger(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return fallback;
  }
  const value = Math.floor(input);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function parseBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input !== 'boolean') {
    return fallback;
  }
  return input;
}

export function parseEnvBoolean(input: string | undefined, fallback: boolean): boolean {
  if (typeof input !== 'string') {
    return fallback;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

export function isSafeRelativeOutputDir(input: string): boolean {
  if (!input || input === '.') {
    return false;
  }
  if (input.startsWith('/') || input.includes('\\')) {
    return false;
  }
  return input.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

export function parseDeployOutputDir(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed || null;
}

export function buildDeploymentIdempotencyPayload(requestPayload: {
  provider: string;
  retry: { maxRetries: number };
  validation: { runBuildIfPresent: boolean; runTestsIfPresent: boolean };
  autoFix: { rehydrateBaseline: boolean; bootstrapToolchain: boolean };
  toolchain: { manager: string | null; version: string | null };
  cache: { dependencyCache: boolean };
  deploy: { outputDir: string | null };
  rollbackOnFailure: boolean;
  provenance: {
    trigger: string;
    taskId: string | null;
    operationId: string | null;
    note: string | null;
    repo: string | null;
    sessionIds: string[];
    transcriptUrl: string | null;
    intentSessionContext: string[];
  };
}, options?: { includeRepo?: boolean }): Record<string, unknown> {
  const includeRepo = options?.includeRepo ?? true;
  const provenancePayload: Record<string, unknown> = includeRepo
    ? {
        trigger: requestPayload.provenance.trigger,
        taskId: requestPayload.provenance.taskId,
        operationId: requestPayload.provenance.operationId,
        repo: requestPayload.provenance.repo,
        note: null,
      }
    : {
        trigger: requestPayload.provenance.trigger,
        taskId: requestPayload.provenance.taskId,
        operationId: requestPayload.provenance.operationId,
        note: null,
      };

  const payload: Record<string, unknown> = {
    provider: requestPayload.provider,
    retry: requestPayload.retry,
    validation: requestPayload.validation,
    rollbackOnFailure: requestPayload.rollbackOnFailure,
    provenance: provenancePayload,
  };

  if (requestPayload.autoFix.rehydrateBaseline || requestPayload.autoFix.bootstrapToolchain) {
    payload.autoFix = requestPayload.autoFix;
  }

  if (requestPayload.toolchain.manager || requestPayload.toolchain.version) {
    payload.toolchain = requestPayload.toolchain;
  }

  if (!requestPayload.cache.dependencyCache) {
    payload.cache = requestPayload.cache;
  }

  if (requestPayload.deploy.outputDir) {
    payload.deploy = requestPayload.deploy;
  }

  return payload;
}

export function nextActionForDeploymentError(code: string | undefined): string | null {
  switch (code) {
    case 'toolchain_detect_failed':
      return 'Verify package.json and lockfile metadata, then retry deploy.';
    case 'corepack_missing':
      return 'Use a sandbox image with corepack available, or switch to npm toolchain.';
    case 'package_manager_bootstrap_failed':
      return 'Confirm the requested package manager version is valid and retry deploy.';
    case 'validation_tool_missing':
      return 'Disable build/test validation for this deploy or install required tooling in the sandbox image.';
    case 'validation_command_failed':
      return 'Review test/build output, fix project errors, and retry deploy.';
    case 'dependency_install_failed':
      return 'Dependency installation failed in sandbox; verify lockfile and package manager configuration, then retry deploy.';
    case 'invalid_project_root':
      return 'Set workspace source project root to a safe relative path and retry deploy.';
    case 'baseline_missing':
    case 'baseline_rehydrate_failed':
      return 'Reset the workspace and retry deploy to rebuild git baseline.';
    case 'potential_secrets_detected':
      return 'Remove sensitive files from workspace before deploying (template files like .env.example are allowed).';
    case 'provider_auth_failed':
      return 'Verify CF_ACCOUNT_ID and CF_API_TOKEN, then rerun preflight.';
    case 'provider_scope_missing':
      return 'Grant Workers Scripts/Routes edit scope to CF_API_TOKEN and rerun preflight.';
    case 'provider_project_not_found':
      return 'Set WORKSPACE_DEPLOY_PROJECT_NAME to an existing Workers project and retry.';
    case 'provider_rate_limited':
      return 'Retry deploy after Cloudflare rate limits reset.';
    case 'provider_invalid_output_dir':
      return 'Set deploy.outputDir to a valid static build directory (for example dist or out) and retry.';
    case 'provider_deploy_failed':
      return 'Check provider deployment logs and retry after fixing configuration or build output.';
    default:
      return null;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function ensureWorkspaceReady(env: Env, workspaceId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }

  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  if (workspace.status !== 'ready') {
    return jsonResponse(
      {
        error: 'Workspace is not ready',
        workspace: {
          id: workspace.id,
          status: workspace.status,
          errorCode: workspace.errorCode,
          errorMessage: workspace.errorMessage,
        },
      },
      409
    );
  }
  return null;
}

export async function ensureWorkspaceExists(env: Env, workspaceId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }

  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

export async function ensureWorkspaceDeployEnabled(env: Env): Promise<Response | null> {
  const flags = await loadRuntimeFlags(env);
  if (!flags.workspaceDeployEnabled) {
    return jsonResponse(
      {
        error: 'Workspace deploy is disabled',
        code: 'workspace_deploy_disabled',
      },
      403
    );
  }
  return null;
}
