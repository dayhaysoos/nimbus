import type { AuthContext, Env } from '../types.js';
import { getReviewSession } from '../lib/db.js';
import { jsonResponse, requireReviewSessionAccess } from './reviews/shared.js';

export async function handleGetReviewSession(
  sessionId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);

  const accessResponse = await requireReviewSessionAccess(env, sessionId, effectiveAuthContext);
  if (accessResponse) {
    return accessResponse;
  }

  const session = await getReviewSession(env.DB, sessionId);
  if (!session) {
    return jsonResponse({ error: 'Review session not found' }, 404);
  }

  return jsonResponse({ session });
}
