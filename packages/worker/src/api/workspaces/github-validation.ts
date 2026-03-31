import type { Env } from '../../types.js';

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
