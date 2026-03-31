import type { Env } from '../../types.js';
import { OperationPreflightError } from './github-validation.js';

interface GithubRequestOptions {
  method?: string;
  token: string;
  body?: unknown;
}

interface GitHubApiErrorShape {
  message?: string;
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
