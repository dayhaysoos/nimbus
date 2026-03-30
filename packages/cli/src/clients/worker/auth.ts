import type { AuthExchangeHealthResponse, AuthExchangeResponse } from '../../lib/types.js';
import { throwWorkerError, workerFetch, workerFetchWithoutAuth } from './shared.js';

export async function exchangeOidcToken(workerUrl: string, token: string): Promise<AuthExchangeResponse> {
  const response = await workerFetchWithoutAuth(`${workerUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<AuthExchangeResponse>;
}

export async function getAuthExchangeHealth(workerUrl: string): Promise<AuthExchangeHealthResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/auth/exchange/health`, {
    method: 'GET',
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<AuthExchangeHealthResponse>;
}
