import type { Env } from '../../types.js';
import { githubRequest, OperationPreflightError } from './github.js';

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
