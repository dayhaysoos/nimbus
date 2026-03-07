import { execFileSync } from 'child_process';

export const MAX_SOURCE_BUNDLE_BYTES = 100 * 1024 * 1024;

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

function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
      .toString()
      .trim();
  } catch (error) {
    throw new Error(`Failed to resolve git repository root from ${cwd}: ${normalizeGitError(error)}`);
  }
}

export function buildGitArchiveArgs(commitSha: string): string[] {
  return ['archive', '--format=tar.gz', commitSha];
}

export function buildSourceBundleFilename(commitSha: string): string {
  return `checkpoint-${commitSha.slice(0, 12)}.tar.gz`;
}

export function estimateBundleSize(bundle: ArrayBuffer | Uint8Array): number {
  if (bundle instanceof Uint8Array) {
    return bundle.byteLength;
  }

  return bundle.byteLength;
}

export function createSourceArchiveFromCommit(
  commitSha: string,
  options?: {
    cwd?: string;
    maxBytes?: number;
  }
): ArrayBuffer {
  const cwd = options?.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const maxBytes = options?.maxBytes ?? MAX_SOURCE_BUNDLE_BYTES;

  let output: Buffer;
  try {
    output = execFileSync('git', buildGitArchiveArgs(commitSha), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'buffer',
      maxBuffer: maxBytes * 2,
    }) as unknown as Buffer;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create source archive for commit ${commitSha}: ${message}`);
  }

  const size = estimateBundleSize(output);
  if (size <= 0) {
    throw new Error('Source archive is empty');
  }

  if (size > maxBytes) {
    throw new Error(`Source bundle exceeds max size of ${maxBytes} bytes`);
  }

  const copy = new Uint8Array(output.byteLength);
  copy.set(output);
  return copy.buffer;
}
