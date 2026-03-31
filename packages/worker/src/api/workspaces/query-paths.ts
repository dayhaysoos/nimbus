export const DEFAULT_FILE_READ_MAX_BYTES = 256 * 1024;
export const MAX_FILE_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkspaceFileEntry {
  path: string;
  type: 'file' | 'directory';
}

export function parseMaxBytes(url: URL, key: string, defaultValue: number, maxValue: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(Math.max(2, Math.floor(parsed)), maxValue);
}

export function isWorkspacePathValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === 'Invalid path' ||
    error.message === 'Path traversal is not allowed' ||
    error.message === 'Resolved path escapes workspace root' ||
    error.message === 'Query parameter "path" is required' ||
    error.message === 'Query parameter "path" must point to a file'
  );
}

export function normalizeWorkspacePath(raw: string | null, forFile = false): string {
  const initial = (raw ?? '.').trim();
  if (!initial) {
    if (forFile) {
      throw new Error('Query parameter "path" is required');
    }
    return '.';
  }

  const normalizedSlashes = initial.replace(/\\/g, '/');
  if (normalizedSlashes.includes('\u0000')) {
    throw new Error('Invalid path');
  }

  const withoutLeading = normalizedSlashes.replace(/^\/+/, '');
  const parts = withoutLeading.split('/').filter((segment) => segment.length > 0 && segment !== '.');

  for (const part of parts) {
    if (part === '..') {
      throw new Error('Path traversal is not allowed');
    }
  }

  const normalized = parts.join('/');
  if (forFile && normalized.length === 0) {
    throw new Error('Query parameter "path" must point to a file');
  }

  return normalized || '.';
}

export function parseWorkspaceListEntries(output: string, requestedPath: string): WorkspaceFileEntry[] {
  const tokens = output.split('\u0000').filter((token) => token.length > 0);
  const entries: WorkspaceFileEntry[] = [];

  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const name = tokens[i];
    const typeToken = tokens[i + 1];
    if (!name || name === '.' || name === '..') {
      continue;
    }

    const type = typeToken === 'directory' ? 'directory' : 'file';
    entries.push({
      path: requestedPath === '.' ? name : `${requestedPath}/${name}`,
      type,
    });
  }

  return entries;
}

export function assertWorkspaceRootSafe(realPath: string): void {
  if (realPath === '/workspace' || realPath.startsWith('/workspace/')) {
    return;
  }

  throw new Error('Resolved path escapes workspace root');
}
