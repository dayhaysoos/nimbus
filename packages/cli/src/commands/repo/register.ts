import * as p from '@clack/prompts';
import { execFileSync } from 'child_process';
import { getWorkerUrl, registerRepo } from '../../lib/api.js';

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
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : null;
  }

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/i, '');
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : null;
  } catch {
    return null;
  }
}

function detectRepoSlugFromGitOrigin(): string {
  let origin = '';
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
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

export async function registerRepoCommand(options?: { repo?: string; dryRun?: boolean }): Promise<void> {
  const workerUrl = getWorkerUrl();
  const repoSlug = typeof options?.repo === 'string' && options.repo.trim() ? options.repo.trim() : detectRepoSlugFromGitOrigin();

  if (options?.dryRun === true) {
    p.log.success('Repo registration dry run passed.');
    p.log.message(`Repository slug: ${repoSlug}`);
    p.log.message(`Worker URL: ${workerUrl}`);
    p.log.message('No network request was sent.');
    return;
  }

  try {
    const response = await registerRepo(workerUrl, repoSlug);
    if (response.status === 'already_registered') {
      p.log.success(`Repository already registered: ${response.repoSlug}`);
      p.log.message(`Account ID: ${response.accountId}`);
      return;
    }

    p.log.success(`Repository registered: ${response.repoSlug}`);
    p.log.message(`Account ID: ${response.accountId}`);
    p.log.message('Setup complete. CI can now exchange GitHub OIDC tokens for short-lived Nimbus auth tokens.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Worker error (409)')) {
      throw new Error(
        `Repository ${repoSlug} is already registered to a different Nimbus account. Ask an admin to transfer ownership.`
      );
    }
    throw error;
  }
}
