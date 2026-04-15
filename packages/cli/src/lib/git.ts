import { execFileSync } from 'child_process';

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_EAGAIN_RETRIES = 10;
const GIT_EAGAIN_SLEEP_MS = 100;

function parseRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('git@')) {
    const idx = trimmed.indexOf(':');
    if (idx < 0) {
      return null;
    }
    const path = trimmed.slice(idx + 1).replace(/\.git$/i, '');
    return REPO_SLUG_PATTERN.test(path) ? path : null;
  }

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/i, '');
    return REPO_SLUG_PATTERN.test(path) ? path : null;
  } catch {
    return null;
  }
}

export function detectRepoSlugFromGitOrigin(cwd = process.cwd()): string {
  let origin = '';
  let lastError: unknown = null;

  for (let attempt = 0; attempt < GIT_EAGAIN_RETRIES; attempt += 1) {
    try {
      origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!isGitEagainError(error) || attempt >= GIT_EAGAIN_RETRIES - 1) {
        break;
      }
      sleepSync(GIT_EAGAIN_SLEEP_MS * (attempt + 1));
    }
  }

  if (!origin) {
    const details = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not detect git remote origin: ${details}`);
  }

  const slug = parseRepoSlug(origin);
  if (!slug) {
    throw new Error('Could not infer repo slug from git remote origin. Provide --repo <owner/repo>.');
  }

  return slug;
}

function isGitEagainError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const maybeError = error as { code?: unknown; message?: unknown };
    if (maybeError.code === 'EAGAIN') {
      return true;
    }
    if (
      typeof maybeError.message === 'string' &&
      (maybeError.message.includes('EAGAIN') ||
        maybeError.message.includes('Resource temporarily unavailable') ||
        maybeError.message.includes('cannot fork()'))
    ) {
      return true;
    }
  }
  return false;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short synchronous retry backoff for transient git spawn failures
  }
}
