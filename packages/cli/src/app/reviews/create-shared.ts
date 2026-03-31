import { createHash } from 'crypto';
import type { createReview } from '../../clients/worker/reviews.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import { GitRepo } from '../../lib/checkpoint/git.js';

export const MAX_COMMIT_DIFF_PATCH_CHARS = 120_000;
export const COCHANGE_LOOKBACK_SESSIONS = 5;
export const COCHANGE_TOP_N = 20;

export type ReviewCreateProvenance = NonNullable<Parameters<typeof createReview>[2]['provenance']>;

function readRecordString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

export function isExpectedLocalCochangeResolutionError(message: string): boolean {
  return (
    /not a git repository/i.test(message) ||
    /unable to resolve entire checkpoints branch reference/i.test(message) ||
    /failed to resolve git repository/i.test(message) ||
    /unknown revision/i.test(message) ||
    /bad revision/i.test(message)
  );
}

export function parseChangedPathsFromDiff(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ ')) {
      continue;
    }
    const raw = line.slice(4).trim();
    if (!raw || raw === '/dev/null') {
      continue;
    }
    const normalized = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '/dev/null') {
      continue;
    }
    paths.add(normalized);
  }
  return Array.from(paths);
}

export function buildIdempotencyKey(workspaceId: string, deploymentId: string): string {
  const seed = `${workspaceId}:${deploymentId}:${Date.now()}:${Math.random()}`;
  return `review-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function normalizeBranchRefForProvenance(value: string): string | null {
  const normalized = value.trim().replace(/^refs\/heads\//, '');
  if (!normalized) {
    return null;
  }
  if (/[\s~^:?*\[\\]/.test(normalized) || normalized.includes('..') || normalized.includes('@{')) {
    return null;
  }
  if (!/^[A-Za-z0-9._\/-]+$/.test(normalized)) {
    return null;
  }
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.startsWith('.') ||
    normalized.endsWith('.') ||
    normalized.includes('//') ||
    normalized.includes('/.') ||
    normalized.includes('./') ||
    normalized.endsWith('.lock')
  ) {
    return null;
  }
  return normalized;
}

/**
 * Resolves git provenance required by worker review creation.
 * Falls back to GITHUB_HEAD_REF when local branch detection is unavailable (for CI detached-head runs).
 */
export function resolveReviewGitProvenance(): { repo: string; branch: string } {
  let branchCandidate = '';
  try {
    branchCandidate = new GitRepo(process.cwd()).getCurrentBranchRef() ?? '';
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve current git branch: ${details}`);
  }

  let branch = normalizeBranchRefForProvenance(branchCandidate);

  if (!branch) {
    const githubHeadRef = typeof process.env.GITHUB_HEAD_REF === 'string' ? process.env.GITHUB_HEAD_REF.trim() : '';
    if (githubHeadRef) {
      branch = normalizeBranchRefForProvenance(githubHeadRef);
      if (!branch) {
        throw new Error(`GITHUB_HEAD_REF is present but invalid for branch provenance: ${githubHeadRef}`);
      }
    }
  }

  if (!branch) {
    throw new Error(
      'Could not resolve current git branch (git branch detection failed and GITHUB_HEAD_REF not set). In GitHub Actions, ensure GITHUB_HEAD_REF is available in the workflow environment.'
    );
  }

  let repo = '';
  try {
    repo = detectRepoSlugFromGitOrigin();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve git repo slug from origin: ${details}`);
  }

  return { repo: repo.trim(), branch };
}

export function formatReviewExecutionFailure(
  status: string,
  finalReview: { error?: { code: string; message: string } },
  lastFailureEvent: Record<string, unknown> | null
): string {
  const details: string[] = [];

  if (finalReview.error?.code && finalReview.error?.message) {
    details.push(`${finalReview.error.code}: ${finalReview.error.message}`);
  }

  if (lastFailureEvent) {
    const eventType = readRecordString(lastFailureEvent, 'type');
    const reason = readRecordString(lastFailureEvent, 'reason');
    const githubResponseBody = readRecordString(lastFailureEvent, 'githubResponseBody');
    const code = readRecordString(lastFailureEvent, 'code');
    const message = readRecordString(lastFailureEvent, 'message');

    if (eventType) {
      details.push(`event=${eventType}`);
    }
    if (reason) {
      details.push(`reason=${reason}`);
    }
    if (code && message) {
      details.push(`${code}: ${message}`);
    }
    if (githubResponseBody) {
      details.push(`details=${githubResponseBody}`);
    }
  }

  if (details.length === 0) {
    return `Review flow failed at review execution: review ended with status ${status}`;
  }

  return `Review flow failed at review execution: review ended with status ${status} (${details.join(' | ')})`;
}

export function buildWorkspaceIdempotencyKey(commitSha: string): string {
  return `workspace-${createHash('sha256').update(`${commitSha}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
}

export function deriveIdempotencyKey(base: string, scope: 'deploy' | 'review'): string {
  return `${scope}-${createHash('sha256').update(`${base}:${scope}`).digest('hex').slice(0, 20)}`;
}

export function normalizeResultUrl(workerUrl: string, resultUrl: string): string {
  try {
    return new URL(resultUrl, workerUrl).toString();
  } catch {
    return resultUrl;
  }
}

export function normalizeCommitDiffPatch(patch: string): {
  patch: string;
  sha256: string;
  truncated: boolean;
  originalChars: number;
} {
  const originalChars = patch.length;
  const sha256 = createHash('sha256').update(patch).digest('hex');
  if (originalChars <= MAX_COMMIT_DIFF_PATCH_CHARS) {
    return {
      patch,
      sha256,
      truncated: false,
      originalChars,
    };
  }

  return {
    patch: `${patch.slice(0, MAX_COMMIT_DIFF_PATCH_CHARS)}\n\n[... NIMBUS TRUNCATED COMMIT PATCH ...]\n`,
    sha256,
    truncated: true,
    originalChars,
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
