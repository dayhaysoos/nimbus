import type { DeployReadinessResponse, ReviewReadinessResponse } from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

export async function getDeployReadiness(workerUrl: string): Promise<DeployReadinessResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/system/deploy-readiness`);
  if (!response.ok) {
    await throwWorkerError(response);
  }
  return response.json() as Promise<DeployReadinessResponse>;
}

export async function getReviewReadiness(workerUrl: string): Promise<ReviewReadinessResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/system/review-readiness`);
  if (!response.ok) {
    await throwWorkerError(response);
  }
  return response.json() as Promise<ReviewReadinessResponse>;
}
