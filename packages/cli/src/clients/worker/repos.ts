import type { RepoRegisterResponse } from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

export async function registerRepo(workerUrl: string, repoSlug: string): Promise<RepoRegisterResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/repos/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ repo_slug: repoSlug }),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<RepoRegisterResponse>;
}
