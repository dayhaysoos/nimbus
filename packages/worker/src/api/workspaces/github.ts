import type { Env } from '../../types.js';
import { createGitHubAppJwt } from './github-auth.js';

export interface GithubTargetPayload {
  owner: string;
  repo: string;
  branch?: string;
}

export interface ForkGithubPayload {
  target: GithubTargetPayload;
  commit?: {
    message?: string;
  };
  installationId?: number;
}

interface GithubRequestOptions {
  method?: string;
  token: string;
  body?: unknown;
}

interface GitHubApiErrorShape {
  message?: string;
}

export class OperationPreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OperationPreflightError';
  }
}

export function parseForkGithubPayload(payload: Record<string, unknown>): ForkGithubPayload {
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new OperationPreflightError('invalid_request', 'Fork request requires a target object');
  }

  const owner = String((target as Record<string, unknown>).owner ?? '').trim();
  const repo = String((target as Record<string, unknown>).repo ?? '').trim();
  const branchRaw = (target as Record<string, unknown>).branch;
  const branch = typeof branchRaw === 'string' ? branchRaw.trim() : undefined;
  if (!owner || !repo) {
    throw new OperationPreflightError('invalid_request', 'Fork request target requires owner and repo');
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new OperationPreflightError('invalid_request', 'Fork request target owner is invalid');
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.includes('..') || repo.includes('/')) {
    throw new OperationPreflightError('invalid_request', 'Fork request target repo is invalid');
  }

  const commitInput = payload.commit;
  let commitMessage: string | undefined;
  if (commitInput && typeof commitInput === 'object' && !Array.isArray(commitInput)) {
    const maybeMessage = (commitInput as Record<string, unknown>).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      commitMessage = maybeMessage.trim();
    }
  }

  const installationIdRaw = payload.installationId;
  let installationId: number | undefined;
  if (typeof installationIdRaw === 'number' && Number.isFinite(installationIdRaw)) {
    const normalized = Math.floor(installationIdRaw);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new OperationPreflightError('invalid_request', 'installationId must be a positive integer');
    }
    installationId = normalized;
  }

  return {
    target: { owner, repo, branch },
    commit: commitMessage ? { message: commitMessage } : undefined,
    installationId,
  };
}

function getAllowedForkOrgs(env: Env): Set<string> {
  return new Set(
    (env.GITHUB_FORK_ALLOWED_ORGS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

export function enforceForkTargetPolicy(env: Env, owner: string): void {
  const allowedOrgs = getAllowedForkOrgs(env);
  if (allowedOrgs.size === 0) {
    return;
  }

  if (!allowedOrgs.has(owner.toLowerCase())) {
    throw new OperationPreflightError('target_repo_not_allowed', 'Target repository owner is not allowed', {
      owner,
      policy: 'org_allowlist',
    });
  }
}

export async function githubRequest<T>(env: Env, path: string, options: GithubRequestOptions): Promise<T> {
  const baseUrl = (env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const apiError = json as GitHubApiErrorShape | null;
    throw new OperationPreflightError('github_api_error', apiError?.message || 'GitHub API request failed', {
      path,
      status: response.status,
    });
  }

  return json as T;
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const sec = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

function sanitizeBranchName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/, '/')
    .replace(/_+/g, '_')
    .replace(/^[-/_.]+/, '')
    .replace(/[-/_.]+$/, '');

  const clamped = normalized.slice(0, 240);
  if (!clamped) {
    throw new OperationPreflightError('invalid_branch', 'Computed branch name is empty after sanitization');
  }

  return clamped;
}

function getDefaultForkBranch(workspaceId: string): string {
  return sanitizeBranchName(`nimbus/${workspaceId}/${formatTimestamp(new Date())}`);
}

export async function resolveGitHubInstallationId(
  env: Env,
  appJwt: string,
  owner: string,
  repo: string,
  installationOverride?: number
): Promise<number> {
  if (installationOverride) {
    return installationOverride;
  }

  const installation = await githubRequest<{ id: number }>(env, `/repos/${owner}/${repo}/installation`, { token: appJwt });
  return installation.id;
}

export async function createInstallationToken(env: Env, appJwt: string, installationId: number): Promise<string> {
  const tokenResponse = await githubRequest<{ token: string }>(env, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt,
    body: {},
  });
  return tokenResponse.token;
}

export async function resolveBranchForFork(
  env: Env,
  token: string,
  owner: string,
  repo: string,
  requestedBranch: string | undefined,
  workspaceId: string
): Promise<{ branch: string; explicit: boolean }> {
  const explicit = Boolean(requestedBranch && requestedBranch.trim().length > 0);
  const branchBase = sanitizeBranchName(requestedBranch?.trim() || getDefaultForkBranch(workspaceId));
  if (explicit) {
    try {
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branchBase)}`, { token });
      throw new OperationPreflightError('branch_exists', 'Requested branch already exists', { branch: branchBase });
    } catch (error) {
      if (error instanceof OperationPreflightError && error.code === 'github_api_error') {
        const details = error.details ?? {};
        if (typeof details === 'object' && details && (details as Record<string, unknown>).status === 404) {
          return { branch: branchBase, explicit: true };
        }
      }
      if (error instanceof OperationPreflightError && error.code === 'branch_exists') {
        throw error;
      }
      throw error;
    }
  }

  let candidate = branchBase;
  for (let index = 1; index <= 50; index += 1) {
    try {
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(candidate)}`, { token });
      candidate = `${branchBase}-${index + 1}`;
    } catch (error) {
      if (error instanceof OperationPreflightError && error.code === 'github_api_error') {
        const details = error.details ?? {};
        if (typeof details === 'object' && details && (details as Record<string, unknown>).status === 404) {
          return { branch: candidate, explicit: false };
        }
      }
      throw error;
    }
  }

  throw new OperationPreflightError('branch_exists', 'Unable to allocate non-colliding generated branch');
}
