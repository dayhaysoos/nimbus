import { execFileSync } from 'child_process';

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not detect git remote origin: ${details}`);
  }

  const slug = parseRepoSlug(origin);
  if (!slug) {
    throw new Error('Could not infer repo slug from git remote origin. Provide --repo <owner/repo>.');
  }

  return slug;
}
