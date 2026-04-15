import * as p from '@clack/prompts';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { parseCommitTrailers, parseDeployInput, resolveCheckpointFromHistory } from '../../lib/checkpoint/resolver.js';
import { resolveCochangeFromLocalGit, resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';
import type { EntireIntentContext } from '../../lib/entire/context.js';

export type ReviewContextMode = 'intent_aware' | 'basic';

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
  includedCheckpoints?: IncludedCheckpointSummary[];
  checkpointSelectionMode?: 'latest' | 'last_n' | 'range';
}

interface ResolveCommitContextOptions {
  baseRef?: string;
  lastCheckpoints?: number;
  checkpointRange?: string;
}

export interface IncludedCheckpointSummary {
  checkpointId: string;
  commitSha: string;
  commitSubject: string;
}

export interface ReviewCommitValidationResult {
  commitSha: string;
  checkpointId: string;
  commitDiffPatch: string;
  checkpointResolution?: 'direct';
  includedCheckpoints?: IncludedCheckpointSummary[];
  checkpointSelectionMode?: 'latest' | 'last_n' | 'range';
}

export interface ReviewCommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
  includedCheckpoints?: IncludedCheckpointSummary[];
  checkpointSelectionMode?: 'latest' | 'last_n' | 'range';
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
  contextResolution: 'direct' | 'branch_fallback';
  originalCheckpointId: string;
  resolvedCheckpointId: string;
  resolvedCommitSha: string;
  resolvedCommitSubject: string;
  commitsAgo: number;
  fallbackReason?: string;
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

function commitHistorySubject(message: string): string {
  const firstLine = message.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim() ?? '(no commit subject)';
}

function parseCheckpointRange(value: string): { start: string; end: string } {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('..');
  if (separator <= 0 || separator >= trimmed.length - 2) {
    throw new Error('Invalid --checkpoint-range format. Use <start>..<end>.');
  }
  const start = trimmed.slice(0, separator).trim();
  const end = trimmed.slice(separator + 2).trim();
  if (!start || !end) {
    throw new Error('Invalid --checkpoint-range format. Use <start>..<end>.');
  }
  return { start, end };
}

function buildRangeDiffPatch(git: GitRepo, oldestCommitSha: string, newestCommitSha: string): string {
  if (oldestCommitSha === newestCommitSha) {
    return git.getCommitPatch(newestCommitSha);
  }

  const parentCommitSha = git.run(['rev-parse', '--verify', `${oldestCommitSha}^`]).trim();
  return git.run(['diff', '--no-ext-diff', '--unified=3', parentCommitSha, newestCommitSha], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function selectCheckpointRangeCommits(input: {
  commits: ReturnType<GitRepo['listCommits']>;
  startToken: string;
  endToken: string;
  git: GitRepo;
}): IncludedCheckpointSummary[] {
  const resolveCheckpointPrefix = (token: string): string | null => {
    if (!token.toLowerCase().startsWith('checkpoint:')) {
      return null;
    }
    const raw = token.slice('checkpoint:'.length).trim().toLowerCase();
    if (!raw) {
      throw new Error('Checkpoint ID must be provided after checkpoint: in --checkpoint-range.');
    }

    const matches = input.commits.reduce<string[]>((acc, commit) => {
      const trailers = parseCommitTrailers(commit.message);
      if (trailers.checkpointId && trailers.checkpointId.startsWith(raw)) {
        acc.push(commit.sha);
      }
      return acc;
    }, []);

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Checkpoint token '${token}' is ambiguous on this branch. Use a longer ID.`);
    }
    throw new Error(`No commit found with trailer Entire-Checkpoint matching prefix: ${raw}`);
  };

  const resolveToken = (token: string): string => {
    let parsed: ReturnType<typeof parseDeployInput>;
    try {
      parsed = parseDeployInput(token);
    } catch (error) {
      const fallback = resolveCheckpointPrefix(token);
      if (fallback) {
        return fallback;
      }
      throw error;
    }
    if (parsed.kind === 'checkpoint') {
      const resolved = resolveCheckpointFromHistory(parsed.checkpointId, input.commits);
      return resolved.selected.sha;
    }
    return input.git.resolveCommitSha(parsed.commitish);
  };

  const startCommitSha = resolveToken(input.startToken);
  const endCommitSha = resolveToken(input.endToken);

  const startIndex = input.commits.findIndex((commit) => commit.sha === startCommitSha);
  const endIndex = input.commits.findIndex((commit) => commit.sha === endCommitSha);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error('Checkpoint range commits must exist on the current branch history.');
  }

  const isAncestor = (ancestor: string, descendant: string): boolean => {
    try {
      input.git.run(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };
  if (!isAncestor(startCommitSha, endCommitSha) && !isAncestor(endCommitSha, startCommitSha)) {
    throw new Error('Checkpoint range must be linear ancestry on the current branch.');
  }

  const lower = Math.min(startIndex, endIndex);
  const upper = Math.max(startIndex, endIndex);
  const summaries = input.commits.slice(lower, upper + 1).reduce<IncludedCheckpointSummary[]>((acc, commit) => {
    const trailers = parseCommitTrailers(commit.message);
    if (!trailers.checkpointId) {
      return acc;
    }
    acc.push({
      checkpointId: trailers.checkpointId,
      commitSha: commit.sha,
      commitSubject: commitHistorySubject(commit.message),
    });
    return acc;
  }, []);

  if (summaries.length === 0) {
    throw new Error('Checkpoint range did not include any commits with Entire-Checkpoint trailers.');
  }

  return summaries.reverse();
}

function selectLastNCheckpointCommits(input: {
  commits: ReturnType<GitRepo['listCommits']>;
  headCommitSha: string;
  count: number;
}): IncludedCheckpointSummary[] {
  const headIndex = input.commits.findIndex((commit) => commit.sha === input.headCommitSha);
  if (headIndex < 0) {
    throw new Error('Target commit is not on the current branch history.');
  }
  const summaries: IncludedCheckpointSummary[] = [];
  for (let index = headIndex; index < input.commits.length; index += 1) {
    const commit = input.commits[index];
    const trailers = parseCommitTrailers(commit.message);
    if (!trailers.checkpointId) {
      continue;
    }
    summaries.push({
      checkpointId: trailers.checkpointId,
      commitSha: commit.sha,
      commitSubject: commitHistorySubject(commit.message),
    });
    if (summaries.length >= input.count) {
      break;
    }
  }
  if (summaries.length === 0) {
    throw new Error('No checkpoint commits were found for this branch selection.');
  }
  return summaries.reverse();
}

function resolveCommitTrailersForSelection(input: {
  commits: ReturnType<GitRepo['listCommits']>;
  commitSha: string;
}): ReturnType<typeof parseCommitTrailers> {
  const match = input.commits.find((commit) => commit.sha === input.commitSha);
  if (!match) {
    throw new Error('Target commit is not on the current branch history.');
  }
  return parseCommitTrailers(match.message);
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
    message.includes('metadata was not found on any available Entire checkpoints ref') ||
    message.includes('session entries had no context/prompt paths') ||
    message.includes('session context paths were present but no readable context text could be loaded') ||
    message.includes('had no readable session metadata on any available Entire checkpoints ref') ||
    message.includes('had no readable session metadata') ||
    message.includes('does not have a valid checkpoint ID for Entire context resolution') ||
    message.includes('Unable to resolve Entire checkpoints branch reference')
  );
}

function buildMissingEntireContextHistoryMessage(lastValid: LastCheckpointOnBranch | null): string {
  if (lastValid) {
    return `This commit has no Entire session context. The last commit on this branch with valid checkpoint context was ${lastValid.commitSha.slice(
      0,
      7
    )} ('${lastValid.subject}') ${lastValid.commitsAgo} commits ago. Make sure Entire capture is active before committing.`;
  }
  return buildMissingLocalCheckpointHistoryMessage();
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

function resolveCommitContext(commitish: string, cwd = process.cwd(), options?: ResolveCommitContextOptions): CommitResolution {
  if (resolveCommitForTests) {
    return resolveCommitForTests(commitish, options);
  }

  const git = new GitRepo(cwd);
  const parsedInput = parseDeployInput(commitish);
  const baseRef = typeof options?.baseRef === 'string' && options.baseRef.trim() ? options.baseRef.trim() : null;
  const checkpointRange = typeof options?.checkpointRange === 'string' && options.checkpointRange.trim()
    ? options.checkpointRange.trim()
    : null;
  const lastCheckpoints =
    typeof options?.lastCheckpoints === 'number' && Number.isFinite(options.lastCheckpoints)
      ? Math.max(1, Math.min(3, Math.floor(options.lastCheckpoints)))
      : null;

  if (baseRef && (checkpointRange || lastCheckpoints)) {
    throw new Error('Cannot combine --base with multi-checkpoint selection (--last-checkpoints or --checkpoint-range).');
  }

  if (checkpointRange && lastCheckpoints) {
    throw new Error('Cannot combine --last-checkpoints with --checkpoint-range. Choose one range mode.');
  }

  const ref = git.getCurrentBranchRef() ?? 'HEAD';
  const commits = git.listCommits(ref);

  if (checkpointRange) {
    const { start, end } = parseCheckpointRange(checkpointRange);
    const includedCheckpoints = selectCheckpointRangeCommits({
      commits,
      startToken: start,
      endToken: end,
      git,
    });
    const oldest = includedCheckpoints[0];
    const newest = includedCheckpoints[includedCheckpoints.length - 1];
    return {
      commitSha: newest.commitSha,
      checkpointId: newest.checkpointId,
      commitDiffPatch: buildRangeDiffPatch(git, oldest.commitSha, newest.commitSha),
      includedCheckpoints,
      checkpointSelectionMode: 'range',
    };
  }

  if (lastCheckpoints && lastCheckpoints > 1) {
    const headCommitSha = parsedInput.kind === 'checkpoint'
      ? resolveCheckpointFromHistory(parsedInput.checkpointId, commits).selected.sha
      : git.resolveCommitSha(parsedInput.commitish);
    const headTrailers = resolveCommitTrailersForSelection({
      commits,
      commitSha: headCommitSha,
    });
    if (!headTrailers.checkpointId) {
      throw new Error(buildMissingCheckpointTrailerMessage(headCommitSha, cwd));
    }
    const includedCheckpoints = selectLastNCheckpointCommits({
      commits,
      headCommitSha,
      count: lastCheckpoints,
    });
    const oldest = includedCheckpoints[0];
    return {
      commitSha: headCommitSha,
      checkpointId: headTrailers.checkpointId,
      commitDiffPatch: buildRangeDiffPatch(git, oldest.commitSha, headCommitSha),
      includedCheckpoints,
      checkpointSelectionMode: 'last_n',
    };
  }

  let commitSha: string;
  let trailers: ReturnType<typeof parseCommitTrailers>;
  if (parsedInput.kind === 'checkpoint') {
    try {
      const resolved = resolveCheckpointFromHistory(parsedInput.checkpointId, commits);
      commitSha = resolved.selected.sha;
      trailers = resolved.selected.trailers;
    } catch (error) {
      if (parsedInput.explicit) {
        throw error;
      }

      commitSha = git.resolveCommitSha(commitish);
      trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
    }
  } else {
    commitSha = git.resolveCommitSha(parsedInput.commitish);
    trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
  }

  return {
    commitSha,
    checkpointId: trailers.checkpointId,
    commitDiffPatch: baseRef ? git.getRangePatch(baseRef, commitSha) : git.getCommitPatch(commitSha),
    includedCheckpoints: trailers.checkpointId
      ? [
          {
            checkpointId: trailers.checkpointId,
            commitSha,
            commitSubject: commitHistorySubject(git.getCommitMessage(commitSha)),
          },
        ]
      : undefined,
    checkpointSelectionMode: 'latest',
  };
}

export function validateReviewCommitCheckpoint(
  commitish: string,
  cwd = process.cwd(),
  options?: ResolveCommitContextOptions
): ReviewCommitValidationResult {
  const resolved = resolveReviewCommitTarget(commitish, cwd, options);
  const checkpointId = resolved.checkpointId ?? '';
  if (!checkpointId) {
    throw new Error(buildMissingCheckpointTrailerMessage(resolved.commitSha, cwd));
  }
  return {
    commitSha: resolved.commitSha,
    checkpointId,
    commitDiffPatch: resolved.commitDiffPatch,
    checkpointResolution: 'direct',
    includedCheckpoints: resolved.includedCheckpoints,
    checkpointSelectionMode: resolved.checkpointSelectionMode,
  };
}

export function resolveReviewCommitTarget(
  commitish: string,
  cwd = process.cwd(),
  options?: ResolveCommitContextOptions
): ReviewCommitResolution {
  const normalizedCommitish = commitish.trim() || 'HEAD';
  const resolved = resolveCommitContext(normalizedCommitish, cwd, options);
  if (!resolved.commitDiffPatch.trim()) {
    throw new Error(
      `Commit ${resolved.commitSha.slice(0, 12)} has no diff patch content. Review creation requires meaningful diff context.`
    );
  }
  return resolved;
}

export async function validateReviewEntireIntentContext(
  input: {
    commitSha: string;
    checkpointId: string;
  },
  options?: {
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
    allowBranchFallback?: boolean;
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

    const lastValid = await findLastCommitWithValidCheckpointContext(input.commitSha, options ?? {}, cwd);
    if (options?.allowBranchFallback !== false && lastValid?.context && lastValid.checkpointId) {
      return {
        context: lastValid.context,
        contextResolution: 'branch_fallback',
        originalCheckpointId: input.checkpointId,
        resolvedCheckpointId: lastValid.checkpointId,
        resolvedCommitSha: lastValid.commitSha,
        resolvedCommitSubject: lastValid.subject,
        commitsAgo: lastValid.commitsAgo,
        fallbackReason: message,
      };
    }

    throw new Error(
      `${buildMissingEntireContextHistoryMessage(lastValid)} Direct checkpoint issue: ${message}`
    );
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
    baseRef?: string;
    lastCheckpoints?: number;
    checkpointRange?: string;
    summarizeSession?: 'auto' | 'always' | 'never';
    intentTokenBudget?: number;
    strictEntireContext?: boolean;
  }
): Promise<void> {
  const spinner = p.spinner();
  let resolved: ReviewCommitResolution;
  let contextResolution: ReviewEntireContextResolution | null = null;
  let contextMode: ReviewContextMode = 'intent_aware';

  spinner.start('Resolving review target...');
  try {
    resolved = resolveReviewCommitTarget(commitish, process.cwd(), {
      baseRef: options?.baseRef,
      lastCheckpoints: options?.lastCheckpoints,
      checkpointRange: options?.checkpointRange,
    });
    spinner.stop(
      resolved.checkpointId
        ? `Resolved checkpoint ${resolved.checkpointId} from ${resolved.commitSha.slice(0, 12)}`
        : `Resolved commit ${resolved.commitSha.slice(0, 12)} (basic review mode available)`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Commit/checkpoint validation failed');
    throw new Error(`Review preflight failed: ${message}`);
  }

  if (!resolved.checkpointId) {
    if (options?.strictEntireContext) {
      throw new Error(`Review preflight failed: ${buildMissingCheckpointTrailerMessage(resolved.commitSha, process.cwd())}`);
    }
    contextMode = 'basic';
    p.log.warning(
      `Commit ${resolved.commitSha.slice(0, 12)} has no Entire-Checkpoint trailer. Nimbus can still run a basic review against the diff, changed files, and repo conventions.`
    );
  } else {
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
          allowBranchFallback: !options?.strictEntireContext,
        },
        process.cwd()
      );
      spinner.stop(
        contextResolution.contextResolution === 'branch_fallback'
          ? `Entire session metadata resolved via branch fallback (${contextResolution.resolvedCheckpointId})`
          : 'Entire session metadata is readable'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.stop('Entire session metadata validation failed');
      if (options?.strictEntireContext) {
        throw new Error(`Review preflight failed: ${message}`);
      }
      contextMode = 'basic';
      p.log.warning(
        `Entire session context was not available for checkpoint ${resolved.checkpointId}. Nimbus will fall back to a basic diff/code-aware review.`
      );
      p.log.warning(message);
    }
  }

  spinner.start('Checking co-change token readiness...');
  try {
    if (contextMode === 'basic') {
      spinner.stop('Co-change skipped (basic review mode)');
    } else {
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
      spinner.stop(
        hasLocalCochange ? 'Co-change token check skipped (using local co-change context)' : 'Co-change token readiness confirmed'
      );
    }
    p.log.success('Review preflight passed');
    p.log.message(`Context mode: ${contextMode === 'basic' ? 'basic' : 'intent-aware'}`);
    p.log.message(`Commit: ${resolved.commitSha}`);
    p.log.message(`Checkpoint: ${contextResolution?.resolvedCheckpointId ?? resolved.checkpointId ?? '(none)'}`);
    if (resolved.includedCheckpoints && resolved.includedCheckpoints.length > 1) {
      p.log.message(
        `Included checkpoints (${resolved.checkpointSelectionMode ?? 'range'}): ${resolved.includedCheckpoints
          .map((entry) => `${entry.checkpointId}@${entry.commitSha.slice(0, 7)}`)
          .join(', ')}`
      );
    }
    if (contextResolution?.contextResolution === 'branch_fallback') {
      p.log.warning(
        `Using fallback Entire context from commit ${contextResolution.resolvedCommitSha.slice(0, 7)} ('${contextResolution.resolvedCommitSubject}') ${contextResolution.commitsAgo} commits ago.`
      );
      if (contextResolution.fallbackReason) {
        p.log.warning(`Direct checkpoint context issue: ${contextResolution.fallbackReason}`);
      }
    }
    if (contextMode === 'basic') {
      p.log.warning('Entire intent context unavailable; Nimbus will review the diff, changed files, and repository conventions only.');
    } else {
      p.log.message(
        `Session IDs: ${contextResolution?.context.sessionIds.length ? contextResolution.context.sessionIds.join(', ') : '(none)'}`
      );
      p.log.message(`Intent context lines: ${contextResolution?.context.intentSessionContext.length ?? 0}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Co-change token readiness check failed');
    throw new Error(`Review preflight failed: ${message}`);
  }
}
