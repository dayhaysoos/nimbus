import * as p from '@clack/prompts';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { parseCommitTrailers } from '../../lib/checkpoint/resolver.js';
import { resolveCochangeFromLocalGit, resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';
import type { EntireIntentContext } from '../../lib/entire/context.js';

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
}

interface ResolveCommitContextOptions {
  baseRef?: string;
}

export interface ReviewCommitValidationResult {
  commitSha: string;
  checkpointId: string;
  commitDiffPatch: string;
  checkpointResolution?: 'direct';
}

interface LastCheckpointOnBranch {
  commitSha: string;
  subject: string;
  commitsAgo: number;
  checkpointId?: string;
  context?: EntireIntentContext;
}

function buildMissingLocalCheckpointHistoryMessage(): string {
  return [
    'This branch has no Entire session history locally. If running in CI, fetch the checkpoint branch first:',
    '  `git fetch origin entire/checkpoints/v1`',
    'Otherwise make sure Entire capture is active before committing (`entire status` to verify).',
  ].join('\n');
}

export interface ReviewEntireContextResolution {
  context: EntireIntentContext;
  contextResolution: 'direct';
  originalCheckpointId: string;
  resolvedCheckpointId: string;
  resolvedCommitSha: string;
  resolvedCommitSubject: string;
  commitsAgo: number;
}

function parseChangedPathsFromDiff(patch: string): string[] {
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

let resolveCommitForTests: ((commitish: string, options?: ResolveCommitContextOptions) => CommitResolution) | null = null;
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
let resolveLocalCochangeAvailabilityForTests: ((changedPaths: string[], cwd: string) => boolean) | null = null;

export function setReviewPreflightCommitResolverForTests(
  resolver: ((commitish: string, options?: ResolveCommitContextOptions) => CommitResolution) | null
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

export function setReviewPreflightLocalCochangeResolverForTests(
  resolver: ((changedPaths: string[], cwd: string) => boolean) | null
): void {
  resolveLocalCochangeAvailabilityForTests = resolver;
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
      checkpointId: trailers.checkpointId,
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

  return buildMissingLocalCheckpointHistoryMessage();
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
  return buildMissingLocalCheckpointHistoryMessage();
}

function resolveCommitContext(commitish: string, cwd = process.cwd(), options?: ResolveCommitContextOptions): CommitResolution {
  if (resolveCommitForTests) {
    return resolveCommitForTests(commitish, options);
  }
  const git = new GitRepo(cwd);
  const commitSha = git.resolveCommitSha(commitish);
  const trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
  const baseRef = typeof options?.baseRef === 'string' && options.baseRef.trim() ? options.baseRef.trim() : null;
  return {
    commitSha,
    checkpointId: trailers.checkpointId,
    commitDiffPatch: baseRef ? git.getRangePatch(baseRef, commitSha) : git.getCommitPatch(commitSha),
  };
}

export function validateReviewCommitCheckpoint(
  commitish: string,
  cwd = process.cwd(),
  options?: ResolveCommitContextOptions
): ReviewCommitValidationResult {
  const normalizedCommitish = commitish.trim() || 'HEAD';
  const resolved = resolveCommitContext(normalizedCommitish, cwd, options);
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
    checkpointResolution: 'direct',
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
    throw new Error(await buildMissingEntireContextMessage(input.commitSha, options ?? {}, cwd));
  }
}

export async function validateReviewCochangeTokenReadiness(options?: {
  localCochangeAvailable?: boolean;
}): Promise<'confirmed' | 'legacy_unknown'> {
  if (options?.localCochangeAvailable) {
    return 'confirmed';
  }

  const missingTokenMessage =
    'REVIEW_CONTEXT_GITHUB_TOKEN is required for GitHub co-change retrieval when local co-change context is unavailable. Set a scoped token in your shell before running review create (the worker no longer uses a global fallback token).';

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
      throw new Error(missingTokenMessage);
    }
    return 'confirmed';
  }

  throw new Error(missingTokenMessage);
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
    spinner.stop('Entire session metadata is readable');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Entire session metadata validation failed');
    throw new Error(`Review preflight failed: ${message}`);
  }

  spinner.start('Checking co-change token readiness...');
  try {
    const changedPaths = parseChangedPathsFromDiff(resolved.commitDiffPatch);
    let hasLocalCochange = false;
    try {
      if (resolveLocalCochangeAvailabilityForTests) {
        hasLocalCochange = resolveLocalCochangeAvailabilityForTests(changedPaths, process.cwd());
      } else {
        hasLocalCochange = Boolean(
          resolveCochangeFromLocalGit(changedPaths, process.cwd(), {
            lookbackSessions: 5,
            topN: 20,
          })
        );
      }
    } catch {
      hasLocalCochange = false;
    }

    await validateReviewCochangeTokenReadiness({
      localCochangeAvailable: hasLocalCochange,
    });
    spinner.stop(hasLocalCochange ? 'Co-change token check skipped (using local co-change context)' : 'Co-change token readiness confirmed');
    p.log.success('Review preflight passed');
    p.log.message(`Commit: ${resolved.commitSha}`);
    p.log.message(`Checkpoint: ${contextResolution.resolvedCheckpointId}`);
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
