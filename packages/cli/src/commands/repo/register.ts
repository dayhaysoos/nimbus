import * as p from '@clack/prompts';
import { getWorkerUrl, registerRepo } from '../../lib/api.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function registerRepoCommand(options?: { repo?: string; dryRun?: boolean; json?: boolean }): Promise<void> {
  const workerUrl = getWorkerUrl();
  const repoSlug = typeof options?.repo === 'string' && options.repo.trim() ? options.repo.trim() : detectRepoSlugFromGitOrigin();
  if (!REPO_SLUG_PATTERN.test(repoSlug)) {
    throw new Error(`Invalid repository slug: ${repoSlug}. Use owner/repo format.`);
  }

  if (options?.dryRun === true) {
    if (options?.json === true) {
      console.log(
        JSON.stringify({
          status: 'dry_run',
          repoSlug,
          workerUrl,
          networkRequestSent: false,
        })
      );
      return;
    }
    p.log.success('Repo registration dry run passed.');
    p.log.message(`Repository slug: ${repoSlug}`);
    p.log.message(`Worker URL: ${workerUrl}`);
    p.log.message('No network request was sent.');
    return;
  }

  try {
    const response = await registerRepo(workerUrl, repoSlug);
    if (options?.json === true) {
      console.log(JSON.stringify(response));
      return;
    }
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
