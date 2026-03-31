import type { AdminApiKeyCreateResponse } from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

export async function createAdminApiKey(
  workerUrl: string,
  payload: {
    label: string;
    accountId?: string;
    isAdmin?: boolean;
  }
): Promise<AdminApiKeyCreateResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/admin/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<AdminApiKeyCreateResponse>;
}
