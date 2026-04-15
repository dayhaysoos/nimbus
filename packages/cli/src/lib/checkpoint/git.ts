import { execFileSync } from 'child_process';
import type { CommitHistoryEntry, TreeFileEntry } from './resolver.js';

const LARGE_GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_EAGAIN_RETRIES = 10;
const GIT_EAGAIN_SLEEP_MS = 100;

export function parseGitLogOutput(output: string): CommitHistoryEntry[] {
  const records = output.split('\u001e').map((record) => record.trim()).filter(Boolean);
  const commits: CommitHistoryEntry[] = [];

  for (const record of records) {
    const separatorIndex = record.indexOf('\u001f');
    if (separatorIndex < 0) {
      continue;
    }

    const sha = record.slice(0, separatorIndex).trim();
    const message = record.slice(separatorIndex + 1);
    if (!sha) {
      continue;
    }

    commits.push({ sha, message });
  }

  return commits;
}

export function parseGitLsTreeNameOnlyOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function treeOutputHasSubmodule(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith('160000 '));
}

function normalizeGitError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOBUFS') {
      return `git output exceeded the configured buffer limit (${LARGE_GIT_OUTPUT_MAX_BUFFER_BYTES} bytes)`;
    }
  }

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

function isGitEagainError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const maybeError = error as { code?: string; message?: string };
    if (maybeError.code === 'EAGAIN') {
      return true;
    }
    if (typeof maybeError.message === 'string' && (maybeError.message.includes('EAGAIN') || maybeError.message.includes('Resource temporarily unavailable') || maybeError.message.includes('cannot fork()'))) {
      return true;
    }
  }
  return false;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short synchronous retry backoff for spawnSync git EAGAIN
  }
}

function execGitSync(
  cwd: string,
  args: string[],
  options?: { encoding?: 'utf8'; maxBuffer?: number; stdio?: ['ignore', 'pipe', 'pipe'] }
): string {
  for (let attempt = 0; attempt < GIT_EAGAIN_RETRIES; attempt += 1) {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: options?.encoding ?? 'utf8',
        maxBuffer: options?.maxBuffer,
        stdio: options?.stdio ?? ['ignore', 'pipe', 'pipe'],
      }) as string | Buffer | null;
      if (output == null) {
        return '';
      }
      if (typeof output === 'string') {
        return output;
      }
      return output.toString('utf8');
    } catch (error) {
      if (isGitEagainError(error) && attempt < GIT_EAGAIN_RETRIES - 1) {
        sleepSync(GIT_EAGAIN_SLEEP_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`git ${args.join(' ')} failed: exhausted retry attempts`);
}

export class GitRepo {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = this.resolveRepoRoot(cwd);
  }

  private resolveRepoRoot(cwd: string): string {
    try {
      return execGitSync(cwd, ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      throw new Error(`Unable to locate git repository root from ${cwd}: ${normalizeGitError(error)}`);
    }
  }

  getRepoRoot(): string {
    return this.cwd;
  }

  run(args: string[], options?: { maxBuffer?: number }): string {
    try {
      return execGitSync(this.cwd, args, {
        encoding: 'utf8',
        maxBuffer: options?.maxBuffer,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`git ${args.join(' ')} failed: ${normalizeGitError(error)}`);
    }
  }

  resolveCommitSha(commitish: string): string {
    const resolved = this.run(['rev-parse', '--verify', `${commitish}^{commit}`]).trim();
    if (!resolved) {
      throw new Error(`Unable to resolve commit-ish: ${commitish}`);
    }
    return resolved;
  }

  getCommitMessage(sha: string): string {
    return this.run(['show', '-s', '--format=%B', sha]);
  }

  getCommitPatch(sha: string): string {
    return this.run(['show', '--format=', '--no-ext-diff', '--unified=3', sha], {
      maxBuffer: LARGE_GIT_OUTPUT_MAX_BUFFER_BYTES,
    });
  }

  getRangePatch(baseRef: string, headSha: string): string {
    // Use three-dot range for PR-style diffs: merge-base(baseRef, headSha)..headSha.
    // This isolates branch-introduced changes relative to the base branch.
    return this.run(['diff', '--no-ext-diff', '--unified=3', `${baseRef}...${headSha}`], {
      maxBuffer: LARGE_GIT_OUTPUT_MAX_BUFFER_BYTES,
    });
  }

  listCommits(ref: string): CommitHistoryEntry[] {
    const output = this.run(['log', '--format=%H%x1f%B%x1e', ref]);
    return parseGitLogOutput(output);
  }

  getCurrentBranchRef(): string | null {
    try {
      const output = this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
      return output || null;
    } catch {
      return null;
    }
  }

  listTreePaths(sha: string): string[] {
    const output = this.run(['ls-tree', '-r', '--name-only', sha]);
    return parseGitLsTreeNameOnlyOutput(output);
  }

  readFileAtCommit(sha: string, path: string): string {
    return this.run(['show', `${sha}:${path}`]);
  }

  listTreeFileEntriesForProjectDetection(sha: string): TreeFileEntry[] {
    const paths = this.listTreePaths(sha);
    const entries: TreeFileEntry[] = [];

    for (const path of paths) {
      if (path.endsWith('/package.json') || path === 'package.json') {
        entries.push({
          path,
          content: this.readFileAtCommit(sha, path),
        });
      } else {
        entries.push({ path });
      }
    }

    return entries;
  }

  ensureNoSubmodules(sha: string): void {
    const output = this.run(['ls-tree', '-r', sha]);
    if (treeOutputHasSubmodule(output)) {
      throw new Error(
        'Checkpoint deploy does not support git submodules in MVP. Remove submodules or choose a different commit.'
      );
    }
  }

  ensureNoGitLfs(sha: string): void {
    const treePaths = this.listTreePaths(sha);
    const gitattributesPaths = treePaths.filter(
      (path) => path === '.gitattributes' || path.endsWith('/.gitattributes')
    );

    for (const path of gitattributesPaths) {
      const content = this.readFileAtCommit(sha, path);
      if (/\bfilter=lfs\b/.test(content)) {
        throw new Error(
          'Checkpoint deploy does not support Git LFS in MVP. Remove LFS tracking or choose a different commit.'
        );
      }
    }
  }
}
