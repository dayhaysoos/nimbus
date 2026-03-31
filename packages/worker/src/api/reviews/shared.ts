import type { AuthContext, Env, ReviewRunStatus } from '../../types.js';
import {
  getReviewRunAccountId,
  getWorkspaceAccountId,
} from '../../lib/db.js';
import { canAccessAccount } from '../../lib/authz.js';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

export const REVIEW_STREAM_POLL_INTERVAL_MS = 1000;
export const REVIEW_STREAM_HEARTBEAT_INTERVAL_MS = 1000;
export const REVIEW_TERMINAL_EVENT_GRACE_MS = 1000;
export const REVIEW_STREAM_STATUS_REFRESH_POLLS = 5;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function requireWorkspaceAccess(env: Env, workspaceId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

export async function requireReviewAccess(env: Env, reviewId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getReviewRunAccountId(env.DB, reviewId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }
  return null;
}

export function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function formatSseDataWithId(seq: number, payload: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveFromSequence(request: Request): number {
  const url = new URL(request.url);
  const fromParam = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const lastEventId = Number.parseInt(request.headers.get('Last-Event-ID') ?? '', 10);

  if (Number.isFinite(lastEventId) && lastEventId >= 0) {
    return lastEventId;
  }
  if (Number.isFinite(fromParam) && fromParam >= 0) {
    return fromParam;
  }
  return 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSeverityThreshold(value: unknown): value is 'low' | 'medium' | 'high' | 'critical' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

export function readReviewGithubTokenHeader(request: Request): string | null {
  const value = request.headers.get('X-Review-Github-Token');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readOpenrouterApiKeyHeader(request: Request): string | null {
  const value = request.headers.get('X-Openrouter-Api-Key');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isReviewStatusActive(status: ReviewRunStatus): boolean {
  return (
    status === 'policy_pending' ||
    status === 'policy_ready' ||
    status === 'policy_approved' ||
    status === 'queued' ||
    status === 'running'
  );
}
