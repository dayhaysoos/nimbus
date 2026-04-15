import * as p from '@clack/prompts';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import type { ReviewEnvironmentRevision } from '../../lib/types.js';
import { GitRepo } from '../../lib/checkpoint/git.js';

export interface LocalReviewEnvironmentRecord {
  sessionId: string;
  repoRoot: string;
  repo: string | null;
  branchName: string;
  mode: 'worktree' | 'branch';
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  environmentRevision: ReviewEnvironmentRevision;
  contextMode: 'basic' | 'intent_aware' | 'unknown';
  materializedAt: string;
}

interface LocalReviewEnvironmentRegistry {
  version: 1;
  entries: LocalReviewEnvironmentRecord[];
}

type LocalEnvironmentChoice = string;
type LocalEnvironmentSelect = (options: {
  message: string;
  options: Array<{ value: LocalEnvironmentChoice; label: string; hint?: string }>;
}) => Promise<unknown>;

const REGISTRY_VERSION = 1;

let registryPathOverride: string | null = null;
let isInteractiveForLocalEnvironments: () => boolean = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);
let selectForLocalEnvironments: LocalEnvironmentSelect = async (options) => p.select(options);

export function setLocalReviewEnvironmentFlowForTests(
  overrides:
    | {
        registryPath?: string | null;
        isInteractive?: () => boolean;
        select?: LocalEnvironmentSelect;
      }
    | null
): void {
  registryPathOverride = overrides?.registryPath ?? null;
  isInteractiveForLocalEnvironments = overrides?.isInteractive ?? (() => Boolean(process.stdout.isTTY && process.stdin.isTTY));
  selectForLocalEnvironments = overrides?.select ?? (async (options) => p.select(options));
}

function registryPath(): string {
  return registryPathOverride ?? join(homedir(), '.nimbus', 'studio', 'materializations.json');
}

function normalizePathForRegistry(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return resolved;
  }

  try {
    return typeof realpathSync.native === 'function' ? realpathSync.native(resolved) : realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeGitError(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim();
    }
    if (stderr && Buffer.isBuffer(stderr) && stderr.toString('utf8').trim()) {
      return stderr.toString('utf8').trim();
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${normalizeGitError(error)}`);
  }
}

function resolveRepoRoot(): string {
  return normalizePathForRegistry(new GitRepo(process.cwd()).getRepoRoot());
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isAncestorCommit(repoRoot: string, ancestorRef: string, descendantRef: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestorRef, descendantRef], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status?: number | null }).status;
      if (status === 1) {
        return false;
      }
    }
    throw new Error(`git merge-base --is-ancestor ${ancestorRef} ${descendantRef} failed: ${normalizeGitError(error)}`);
  }
}

function currentBranchRef(repoRoot: string): string | null {
  try {
    const output = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    return output || null;
  } catch {
    return null;
  }
}

function workingTreeIsClean(repoRoot: string): boolean {
  return runGit(repoRoot, ['status', '--short']).trim() === '';
}

async function readRegistry(): Promise<LocalReviewEnvironmentRegistry> {
  const path = registryPath();
  if (!existsSync(path)) {
    return { version: REGISTRY_VERSION, entries: [] };
  }

  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LocalReviewEnvironmentRegistry> | null;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      version: REGISTRY_VERSION,
      entries: entries.filter((entry): entry is LocalReviewEnvironmentRecord => {
        return Boolean(
          entry &&
            typeof entry === 'object' &&
            typeof entry.sessionId === 'string' &&
            typeof entry.repoRoot === 'string' &&
            typeof entry.branchName === 'string' &&
            typeof entry.mode === 'string' &&
            typeof entry.materializedAt === 'string'
        );
      }),
    };
  } catch {
    return { version: REGISTRY_VERSION, entries: [] };
  }
}

async function writeRegistry(registry: LocalReviewEnvironmentRegistry): Promise<void> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(registry, null, 2), 'utf8');
}

function entryKey(entry: Pick<LocalReviewEnvironmentRecord, 'repoRoot' | 'sessionId' | 'mode'>): string {
  return `${normalizePathForRegistry(entry.repoRoot)}::${entry.sessionId}::${entry.mode}`;
}

export async function recordLocalReviewEnvironment(entry: LocalReviewEnvironmentRecord): Promise<void> {
  const registry = await readRegistry();
  const nextEntries = registry.entries.filter((existing) => entryKey(existing) !== entryKey(entry));
  nextEntries.unshift({
    ...entry,
    repoRoot: normalizePathForRegistry(entry.repoRoot),
  });
  await writeRegistry({
    version: REGISTRY_VERSION,
    entries: nextEntries.sort((left, right) => right.materializedAt.localeCompare(left.materializedAt)),
  });
}

export async function listLocalReviewEnvironments(options?: {
  repoRoot?: string;
}): Promise<LocalReviewEnvironmentRecord[]> {
  const registry = await readRegistry();
  const normalizedRepoRoot = options?.repoRoot ? normalizePathForRegistry(options.repoRoot) : null;
  return registry.entries
    .filter((entry) => !normalizedRepoRoot || normalizePathForRegistry(entry.repoRoot) === normalizedRepoRoot)
    .sort((left, right) => right.materializedAt.localeCompare(left.materializedAt));
}

function formatRelativeTime(isoTimestamp: string): string {
  const then = Date.parse(isoTimestamp);
  if (Number.isNaN(then)) {
    return isoTimestamp;
  }

  const diffMs = then - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (absSeconds < 60) {
    return rtf.format(Math.round(diffMs / 1000), 'second');
  }
  const absMinutes = absSeconds / 60;
  if (absMinutes < 60) {
    return rtf.format(Math.round(diffMs / (60 * 1000)), 'minute');
  }
  const absHours = absMinutes / 60;
  if (absHours < 24) {
    return rtf.format(Math.round(diffMs / (60 * 60 * 1000)), 'hour');
  }
  const absDays = absHours / 24;
  if (absDays < 7) {
    return rtf.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), 'day');
  }
  if (absDays < 30) {
    return rtf.format(Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)), 'week');
  }
  if (absDays < 365) {
    return rtf.format(Math.round(diffMs / (30 * 24 * 60 * 60 * 1000)), 'month');
  }
  return rtf.format(Math.round(diffMs / (365 * 24 * 60 * 60 * 1000)), 'year');
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatContextMode(mode: LocalReviewEnvironmentRecord['contextMode']): string {
  if (mode === 'intent_aware') {
    return 'intent-aware';
  }
  if (mode === 'basic') {
    return 'basic';
  }
  return 'unknown';
}

export async function listLocalReviewEnvironmentsCommand(options?: { all?: boolean }): Promise<void> {
  const repoRoot = options?.all ? undefined : resolveRepoRoot();
  const entries = await listLocalReviewEnvironments({ repoRoot });
  if (entries.length === 0) {
    p.log.warning(
      options?.all
        ? 'No local Nimbus review environments have been materialized yet.'
        : 'No local Nimbus review environments found for this repository.'
    );
    return;
  }

  p.log.info(options?.all ? 'Local review environments' : 'Local review environments for this repository');
  console.log('');
  entries.forEach((entry, index) => {
    const changedFiles = pluralize(entry.environmentRevision.changedFileCount, 'changed file');
    console.log(
      `  ${index + 1}. ${entry.sessionId}  ${entry.mode}  ${formatRelativeTime(entry.materializedAt)}  ${changedFiles}`
    );
    console.log(`     branch ${entry.branchName}`);
    if (options?.all) {
      console.log(`     repo   ${entry.repo ?? entry.repoRoot}`);
    }
    if (entry.worktreePath) {
      console.log(`     path   ${entry.worktreePath}`);
    } else {
      console.log('     path   (branch only)');
    }
    console.log(`     mode   ${formatContextMode(entry.contextMode)}`);
  });
}

async function chooseLocalReviewEnvironment(
  entries: LocalReviewEnvironmentRecord[],
  options?: { message?: string }
): Promise<LocalReviewEnvironmentRecord> {
  if (entries.length === 1 || !isInteractiveForLocalEnvironments()) {
    return entries[0];
  }

  const selection = await selectForLocalEnvironments({
    message: options?.message ?? 'Select a local review environment',
    options: entries.map((entry) => ({
      value: entryKey(entry),
      label: `${entry.sessionId} · ${entry.mode} · ${formatRelativeTime(entry.materializedAt)}`,
      hint: `${pluralize(entry.environmentRevision.changedFileCount, 'changed file')} · ${entry.branchName}`,
    })),
  });

  if (p.isCancel(selection)) {
    throw new Error('Cancelled selecting a local review environment.');
  }

  const chosen = entries.find((entry) => entryKey(entry) === selection);
  if (!chosen) {
    throw new Error('Selected local review environment could not be resolved.');
  }
  return chosen;
}

async function resolveLocalReviewEnvironmentEntry(
  sessionId?: string,
  options?: {
    repoRoot?: string;
    selectionMessage?: string;
    preferWorktree?: boolean;
  }
): Promise<LocalReviewEnvironmentRecord> {
  const entries = await listLocalReviewEnvironments({ repoRoot: options?.repoRoot });
  if (entries.length === 0) {
    throw new Error('No local Nimbus review environments found for this repository. Adopt a session first.');
  }

  const selected = sessionId
    ? (() => {
        const matches = entries.filter((entry) => entry.sessionId === sessionId);
        if (matches.length === 0) {
          return undefined;
        }
        if (options?.preferWorktree) {
          const worktreeMatch = matches.find((entry) => Boolean(entry.worktreePath));
          if (worktreeMatch) {
            return worktreeMatch;
          }
        }
        return matches[0];
      })()
    : await chooseLocalReviewEnvironment(
        options?.preferWorktree
          ? (() => {
              const worktreeEntries = entries.filter((entry) => Boolean(entry.worktreePath));
              return worktreeEntries.length > 0 ? worktreeEntries : entries;
            })()
          : entries,
        { message: options?.selectionMessage }
      );

  if (!selected) {
    throw new Error(`No local Nimbus review environment found for session ${sessionId}.`);
  }

  return selected;
}

function printDiffHeader(entry: LocalReviewEnvironmentRecord, baseRef: string): void {
  p.log.info(`Diffing Nimbus session ${entry.sessionId}`);
  console.log('');
  console.log(`  Base Ref:        ${baseRef}`);
  console.log(`  Materialized:    ${entry.branchName}`);
  console.log(`  Mode:            ${entry.mode}`);
  console.log(`  Changed Files:   ${entry.environmentRevision.changedFileCount}`);
  console.log(`  Materialized At: ${entry.materializedAt} (${formatRelativeTime(entry.materializedAt)})`);
  if (entry.worktreePath) {
    console.log(`  Worktree Path:   ${entry.worktreePath}`);
  }
  console.log('');
}

export async function diffLocalReviewEnvironmentCommand(
  sessionId?: string,
  options?: { baseRef?: string }
): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const selected = await resolveLocalReviewEnvironmentEntry(sessionId, {
    repoRoot,
    selectionMessage: 'Select a local review environment to diff',
    preferWorktree: true,
  });
  if (!branchExists(repoRoot, selected.branchName)) {
    throw new Error(
      `Local review branch ${selected.branchName} no longer exists in this repository. Re-materialize the session before diffing.`
    );
  }

  const baseRef = options?.baseRef?.trim() || 'HEAD';
  printDiffHeader(selected, baseRef);
  const diff = runGit(repoRoot, ['diff', baseRef, selected.branchName]);
  if (!diff.trim()) {
    p.log.success(`No diff between ${baseRef} and ${selected.branchName}.`);
    return;
  }
  process.stdout.write(diff);
  if (!diff.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function printLocalReviewEnvironmentPathCommand(sessionId?: string): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const selected = await resolveLocalReviewEnvironmentEntry(sessionId, {
    repoRoot,
    selectionMessage: 'Select a local review environment to print the path for',
    preferWorktree: true,
  });
  if (!selected.worktreePath) {
    throw new Error(
      `Session ${selected.sessionId} was adopted as branch-only. Use \`git switch ${selected.branchName}\` instead of changing directories.`
    );
  }

  process.stdout.write(`${selected.worktreePath}\n`);
}

export async function printEnterLocalReviewEnvironmentCommand(sessionId?: string): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const selected = await resolveLocalReviewEnvironmentEntry(sessionId, {
    repoRoot,
    selectionMessage: 'Select a local review environment to enter',
    preferWorktree: true,
  });

  const command = selected.worktreePath
    ? `cd -- ${quoteForShell(selected.worktreePath)}`
    : `git switch -- ${quoteForShell(selected.branchName)}`;
  process.stdout.write(`${command}\n`);
}

export async function mergeBackLocalReviewEnvironmentCommand(sessionId?: string): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const selected = await resolveLocalReviewEnvironmentEntry(sessionId, {
    repoRoot,
    selectionMessage: 'Select a local review environment to merge back',
  });

  if (!selected.commitSha) {
    throw new Error(
      `Session ${selected.sessionId} does not have a committed adopted snapshot yet. Commit the adopted changes before merging back.`
    );
  }
  if (!branchExists(repoRoot, selected.branchName)) {
    throw new Error(
      `Local review branch ${selected.branchName} no longer exists in this repository. Re-adopt the session before merging back.`
    );
  }

  const currentBranch = currentBranchRef(repoRoot);
  if (!currentBranch) {
    throw new Error('Current checkout is detached. Switch to the target branch before merging back a Nimbus session.');
  }
  if (currentBranch === selected.branchName) {
    throw new Error(
      `You are already on ${selected.branchName}. Switch to the branch you want to update before merging back this session.`
    );
  }
  if (!workingTreeIsClean(repoRoot)) {
    throw new Error(
      'Current working tree is not clean. Commit or stash local changes before merging back a Nimbus session.'
    );
  }

  if (isAncestorCommit(repoRoot, selected.commitSha, currentBranch)) {
    p.log.info(`Nimbus session ${selected.sessionId} is already applied on ${currentBranch}.`);
    return;
  }

  const cherryStatus = runGit(repoRoot, ['cherry', currentBranch, selected.branchName]);
  const cherryLine = cherryStatus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(selected.commitSha!));
  if (cherryLine?.startsWith('-')) {
    p.log.info(`Nimbus session ${selected.sessionId} is already applied on ${currentBranch}.`);
    return;
  }

  p.log.info(`Merging back Nimbus session ${selected.sessionId}`);
  console.log('');
  console.log(`  Current Branch:  ${currentBranch}`);
  console.log(`  Source Branch:   ${selected.branchName}`);
  console.log(`  Source Commit:   ${selected.commitSha}`);
  console.log(`  Changed Files:   ${selected.environmentRevision.changedFileCount}`);

  try {
    runGit(repoRoot, ['cherry-pick', '-x', selected.commitSha]);
  } catch (error) {
    const message = normalizeGitError(error);
    if (
      message.includes('after resolving the conflicts') ||
      message.includes('could not apply') ||
      message.includes('fix conflicts')
    ) {
      throw new Error(
        `Merge-back hit conflicts while applying ${selected.commitSha}. Resolve them, then run \`git cherry-pick --continue\` or \`git cherry-pick --abort\`.`
      );
    }
    if (message.includes('previous cherry-pick is now empty') || message.includes('nothing to commit')) {
      try {
        runGit(repoRoot, ['cherry-pick', '--abort']);
      } catch {
        // best effort; avoid masking the no-op condition
      }
      p.log.info(`Nimbus session ${selected.sessionId} is already applied on ${currentBranch}.`);
      return;
    }
    throw error;
  }

  const headCommit = runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
  p.log.success(`Applied Nimbus session ${selected.sessionId} onto ${currentBranch}`);
  console.log('');
  console.log(`  Current Branch:  ${currentBranch}`);
  console.log(`  Source Branch:   ${selected.branchName}`);
  console.log(`  Source Commit:   ${selected.commitSha}`);
  console.log(`  New HEAD:        ${headCommit}`);
  if (selected.worktreePath) {
    console.log(`  Worktree Path:   ${selected.worktreePath}`);
  }
}
