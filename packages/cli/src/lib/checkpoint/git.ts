import { execFileSync } from 'child_process';
import type { CommitHistoryEntry, TreeFileEntry } from './resolver.js';

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

export class GitRepo {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = this.resolveRepoRoot(cwd);
  }

  private resolveRepoRoot(cwd: string): string {
    try {
      return execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    } catch (error) {
      throw new Error(`Unable to locate git repository root from ${cwd}: ${normalizeGitError(error)}`);
    }
  }

  getRepoRoot(): string {
    return this.cwd;
  }

  run(args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd: this.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();
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
