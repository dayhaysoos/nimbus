import * as p from '@clack/prompts';
import { getReviewReadiness, getWorkerUrl } from '../../lib/api.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { parseCommitTrailers } from '../../lib/checkpoint/resolver.js';
import { resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';
import type { EntireIntentContext } from '../../lib/entire/context.js';

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
}

export interface ReviewCommitValidationResult {
  commitSha: string;
  checkpointId: string;
  commitDiffPatch: string;
}

interface LastCheckpointOnBranch {
  commitSha: string;
  subject: string;
  commitsAgo: number;
  checkpointId?: string;
  context?: EntireIntentContext;
}

export interface ReviewEntireContextResolution {
  context: EntireIntentContext;
  contextResolution: 'direct' | 'branch_fallback';
  originalCheckpointId: string;
  resolvedCheckpointId: string;
  resolvedCommitSha: string;
  resolvedCommitSubject: string;
  commitsAgo: number;
}

let resolveCommitForTests: ((commitish: string) => CommitResolution) | null = null;
let resolveEntireContextForTests: typeof resolveEntireIntentContextForCommit | null = null;
let resolveLastCheckpointOnBranchForTests: ((commitSha: string, cwd: string) => LastCheckpointOnBranch | null) | null = null;
let resolveLastValidContextOnBranchForTests:
  | ((
      commitSha: string,
      cwd: string,
      options: {
        summarizeSession?: 'auto' | 'always' | 'never';
        intentTokenBudget?: number;
      }
    ) => Promise<LastCheckpointOnBranch | null>)
  | null = null;
let resolveTokenReadinessForTests: (() => Promise<boolean>) | null = null;

export function setReviewPreflightCommitResolverForTests(
  resolver: ((commitish: string) => CommitResolution) | null
): void {
  resolveCommitForTests = resolver;
}

export function setReviewPreflightContextResolverForTests(
  resolver: typeof resolveEntireIntentContextForCommit | null
): void {
  resolveEntireContextForTests = resolver;
}

export function setReviewPreflightLastCheckpointResolverForTests(
  resolver: ((commitSha: string, cwd: string) => LastCheckpointOnBranch | null) | null
): void {
  resolveLastCheckpointOnBranchForTests = resolver;
}

export function setReviewPreflightLastValidContextResolverForTests(
  resolver:
    | ((
        commitSha: string,
        cwd: string,
        options: {
          summarizeSession?: 'auto' | 'always' | 'never';
          intentTokenBudget?: number;
        }
      ) => Promise<LastCheckpointOnBranch | null>)
    | null
): void {
  resolveLastValidContextOnBranchForTests = resolver;
}

export function setReviewPreflightTokenReadinessResolverForTests(
  resolver: (() => Promise<boolean>) | null
): void {
  resolveTokenReadinessForTests = resolver;
}

function commitSubject(message: string): string {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[0] ?? '(no commit subject)';
}

function shouldMapEntireContextErrorToHistoryDiagnostic(message: string): boolean {
  return (
    message.includes('had no readable session metadata on any available Entire checkpoints ref') ||
    message.includes('had no readable session metadata') ||
    message.includes('does not have a valid checkpoint ID for Entire context resolution') ||
    message.includes('Unable to resolve Entire checkpoints branch reference')
  );
}

function findLastCheckpointOnBranch(commitSha: string, cwd = process.cwd()): LastCheckpointOnBranch | null {
  if (resolveLastCheckpointOnBranchForTests) {
    return resolveLastCheckpointOnBranchForTests(commitSha, cwd);
  }

  const git = new GitRepo(cwd);
  const ref = git.getCurrentBranchRef() ?? 'HEAD';
  const commits = git.listCommits(ref);
  if (commits.length === 0) {
    return null;
  }

  const currentIndex = commits.findIndex((entry) => entry.sha === commitSha);
  if (currentIndex < 0) {
    return null;
  }
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  for (let index = startIndex; index < commits.length; index += 1) {
    const trailers = parseCommitTrailers(commits[index].message);
    if (!trailers.checkpointId) {
      continue;
    }
    const commitsAgo = currentIndex >= 0 ? index - currentIndex : index;
    return {
      commitSha: commits[index].sha,
      subject: commitSubject(commits[index].message),
      commitsAgo,
    };
  }

  return null;
}

export function buildMissingCheckpointTrailerMessage(commitSha: string, cwd = process.cwd()): string {
  const lastCheckpoint = findLastCheckpointOnBranch(commitSha, cwd);
  if (lastCheckpoint) {
    return `This commit has no Entire-Checkpoint trailer. The last commit on this branch with valid checkpoint context was ${lastCheckpoint.commitSha.slice(
      0,
      7
    )} ('${lastCheckpoint.subject}') ${lastCheckpoint.commitsAgo} commits ago.`;
  }

  return 'This branch has no Entire session history. Make sure Entire capture is active before committing (`entire status` to verify).';
}

async function findLastCommitWithValidCheckpointContext(
  commitSha: string,
  options: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  },
  cwd = process.cwd()
): Promise<LastCheckpointOnBranch | null> {
  if (resolveLastValidContextOnBranchForTests) {
    return resolveLastValidContextOnBranchForTests(commitSha, cwd, options);
  }

  const git = new GitRepo(cwd);
  const ref = git.getCurrentBranchRef() ?? 'HEAD';
  const commits = git.listCommits(ref);
  if (commits.length === 0) {
    return null;
  }

  const currentIndex = commits.findIndex((entry) => entry.sha === commitSha);
  if (currentIndex < 0) {
    return null;
  }
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const contextResolver = resolveEntireContextForTests ?? resolveEntireIntentContextForCommit;

  for (let index = startIndex; index < commits.length; index += 1) {
    const trailers = parseCommitTrailers(commits[index].message);
    if (!trailers.checkpointId) {
      continue;
    }
    try {
      await contextResolver(commits[index].sha, cwd, {
        checkpointId: trailers.checkpointId,
        summarizeSession: options.summarizeSession ?? 'auto',
        tokenBudget: options.intentTokenBudget,
      });
      const commitsAgo = currentIndex >= 0 ? index - currentIndex : index;
      return {
        commitSha: commits[index].sha,
        subject: commitSubject(commits[index].message),
        commitsAgo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldMapEntireContextErrorToHistoryDiagnostic(message)) {
        throw error;
      }
      continue;
    }
  }

  return null;
}

async function resolveBranchFallbackContext(
  commitSha: string,
  options: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  },
  cwd = process.cwd()
): Promise<LastCheckpointOnBranch | null> {
  const fromResolver = resolveLastValidContextOnBranchForTests
    ? await resolveLastValidContextOnBranchForTests(commitSha, cwd, options)
    : null;
  if (fromResolver) {
    if (fromResolver.checkpointId && fromResolver.context) {
      return fromResolver;
    }
    return null;
  }

  const git = new GitRepo(cwd);
  const ref = git.getCurrentBranchRef() ?? 'HEAD';
  const commits = git.listCommits(ref);
  if (commits.length === 0) {
    return null;
  }

  const currentIndex = commits.findIndex((entry) => entry.sha === commitSha);
  if (currentIndex < 0) {
    return null;
  }
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  const contextResolver = resolveEntireContextForTests ?? resolveEntireIntentContextForCommit;

  for (let index = startIndex; index < commits.length; index += 1) {
    const trailers = parseCommitTrailers(commits[index].message);
    if (!trailers.checkpointId) {
      continue;
    }
    try {
      const context = await contextResolver(commits[index].sha, cwd, {
        checkpointId: trailers.checkpointId,
        summarizeSession: options.summarizeSession ?? 'auto',
        tokenBudget: options.intentTokenBudget,
      });
      const commitsAgo = currentIndex >= 0 ? index - currentIndex : index;
      return {
        commitSha: commits[index].sha,
        subject: commitSubject(commits[index].message),
        commitsAgo,
        checkpointId: trailers.checkpointId,
        context,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!shouldMapEntireContextErrorToHistoryDiagnostic(message)) {
        throw error;
      }
      continue;
    }
  }

  return null;
}

async function buildMissingEntireContextMessage(
  commitSha: string,
  options: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  },
  cwd = process.cwd()
): Promise<string> {
  const lastValid = await findLastCommitWithValidCheckpointContext(commitSha, options, cwd);
  if (lastValid) {
    return `This commit has no Entire session context. The last commit on this branch with valid checkpoint context was ${lastValid.commitSha.slice(
      0,
      7
    )} ('${lastValid.subject}') ${lastValid.commitsAgo} commits ago. Make sure Entire capture is active before committing.`;
  }
  return 'This branch has no Entire session history. Make sure Entire capture is active before committing (`entire status` to verify).';
}

function resolveCommitContext(commitish: string, cwd = process.cwd()): CommitResolution {
  if (resolveCommitForTests) {
    return resolveCommitForTests(commitish);
  }
  const git = new GitRepo(cwd);
  const commitSha = git.resolveCommitSha(commitish);
  const trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
  return {
    commitSha,
    checkpointId: trailers.checkpointId,
    commitDiffPatch: git.getCommitPatch(commitSha),
  };
}

export function validateReviewCommitCheckpoint(
  commitish: string,
  cwd = process.cwd()
): ReviewCommitValidationResult {
  const normalizedCommitish = commitish.trim() || 'HEAD';
  const resolved = resolveCommitContext(normalizedCommitish, cwd);
  const checkpointId = resolved.checkpointId ?? '';
  if (!checkpointId) {
    throw new Error(buildMissingCheckpointTrailerMessage(resolved.commitSha, cwd));
  }
  if (!resolved.commitDiffPatch.trim()) {
    throw new Error(
      `Commit ${resolved.commitSha.slice(0, 12)} has no diff patch content. Review creation requires meaningful diff context.`
    );
  }
  return {
    commitSha: resolved.commitSha,
    checkpointId,
    commitDiffPatch: resolved.commitDiffPatch,
  };
}

export async function validateReviewEntireIntentContext(
  input: {
    commitSha: string;
    checkpointId: string;
  },
  options?: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  },
  cwd = process.cwd()
): Promise<ReviewEntireContextResolution> {
  const contextResolver = resolveEntireContextForTests ?? resolveEntireIntentContextForCommit;
  try {
    const context = await contextResolver(input.commitSha, cwd, {
      checkpointId: input.checkpointId,
      summarizeSession: options?.summarizeSession ?? 'auto',
      tokenBudget: options?.intentTokenBudget,
    });
    return {
      context,
      contextResolution: 'direct',
      originalCheckpointId: input.checkpointId,
      resolvedCheckpointId: input.checkpointId,
      resolvedCommitSha: input.commitSha,
      resolvedCommitSubject: '(current commit)',
      commitsAgo: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!shouldMapEntireContextErrorToHistoryDiagnostic(message)) {
      throw error;
    }

    const fallback = await resolveBranchFallbackContext(input.commitSha, options ?? {}, cwd);
    if (!fallback || !fallback.checkpointId || !fallback.context) {
      throw new Error(await buildMissingEntireContextMessage(input.commitSha, options ?? {}, cwd));
    }
    return {
      context: fallback.context,
      contextResolution: 'branch_fallback',
      originalCheckpointId: input.checkpointId,
      resolvedCheckpointId: fallback.checkpointId,
      resolvedCommitSha: fallback.commitSha,
      resolvedCommitSubject: fallback.subject,
      commitsAgo: fallback.commitsAgo,
    };
  }
}

export async function validateReviewCochangeTokenReadiness(): Promise<'confirmed' | 'legacy_unknown'> {
  const localToken =
    typeof process.env.REVIEW_CONTEXT_GITHUB_TOKEN === 'string' && process.env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
      ? process.env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
      : null;
  if (localToken) {
    return 'confirmed';
  }

  if (resolveTokenReadinessForTests) {
    const ready = await resolveTokenReadinessForTests();
    if (!ready) {
      throw new Error('co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local .env');
    }
    return 'confirmed';
  }

  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local .env');
  }
  let readiness;
  try {
    readiness = await getReviewReadiness(workerUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Worker error (404)')) {
      return 'legacy_unknown';
    }
    throw error;
  }
  if (!readiness.ok) {
    throw new Error('co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local .env');
  }
  return 'confirmed';
}

export async function reviewPreflightCommand(
  commitish = 'HEAD',
  options?: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
  }
): Promise<void> {
  const spinner = p.spinner();
  let resolved: ReviewCommitValidationResult;
  let contextResolution: ReviewEntireContextResolution;

  spinner.start('Resolving commit and checkpoint...');
  try {
    resolved = validateReviewCommitCheckpoint(commitish, process.cwd());
    spinner.stop(`Resolved checkpoint ${resolved.checkpointId} from ${resolved.commitSha.slice(0, 12)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Commit/checkpoint validation failed');
    throw new Error(`Review preflight failed: ${message}`);
  }

  spinner.start('Validating Entire session metadata...');
  try {
    contextResolution = await validateReviewEntireIntentContext(
      {
        commitSha: resolved.commitSha,
        checkpointId: resolved.checkpointId,
      },
      {
      summarizeSession: options?.summarizeSession ?? 'auto',
        intentTokenBudget: options?.intentTokenBudget,
      },
      process.cwd()
    );
    if (contextResolution.contextResolution === 'branch_fallback') {
      spinner.stop(
        `Entire session metadata resolved via branch fallback (${contextResolution.resolvedCheckpointId} from ${contextResolution.resolvedCommitSha.slice(0, 12)})`
      );
    } else {
      spinner.stop('Entire session metadata is readable');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Entire session metadata validation failed');
    throw new Error(`Review preflight failed: ${message}`);
  }

  spinner.start('Checking co-change token readiness...');
  try {
    const readiness = await validateReviewCochangeTokenReadiness();
    if (readiness === 'legacy_unknown') {
      spinner.stop('Co-change token readiness unknown on legacy worker (continuing)');
    } else {
      spinner.stop('Co-change token readiness confirmed');
    }
    p.log.success('Review preflight passed');
    p.log.message(`Commit: ${resolved.commitSha}`);
    p.log.message(`Checkpoint: ${contextResolution.resolvedCheckpointId}`);
    if (contextResolution.contextResolution === 'branch_fallback') {
      p.log.warning(
        `Context fallback: using checkpoint ${contextResolution.resolvedCheckpointId} from ${contextResolution.resolvedCommitSha.slice(0, 7)} (${contextResolution.commitsAgo} commits ago)`
      );
    }
    p.log.message(
      `Session IDs: ${contextResolution.context.sessionIds.length > 0 ? contextResolution.context.sessionIds.join(', ') : '(none)'}`
    );
    p.log.message(`Intent context lines: ${contextResolution.context.intentSessionContext.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Co-change token readiness check failed');
    throw new Error(`Review preflight failed: ${message}`);
  }
}
