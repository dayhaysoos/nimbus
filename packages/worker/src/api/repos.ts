import type { AuthContext, Env } from '../types.js';

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

interface RegisterRepoRequest {
  repo_slug: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function normalizeRepoSlug(repoSlug: string): string {
  return repoSlug.trim().toLowerCase();
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /unique constraint/i.test(error.message) || /constraint failed/i.test(error.message);
}

async function lookupRegistrationAccount(env: Env, repoSlug: string): Promise<string | null> {
  const existing = await env.DB.prepare('SELECT account_id FROM nimbus_repo_registrations WHERE repo_slug = ?')
    .bind(repoSlug)
    .first<{ account_id: string }>();
  return existing?.account_id ?? null;
}

export async function handleRegisterRepo(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  if (authContext.isHostedMode !== true) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }

  const rawApiKey = request.headers.get('X-Nimbus-Api-Key')?.trim() ?? '';
  if (!rawApiKey || rawApiKey.startsWith('nmb_jwt_')) {
    return jsonResponse({ error: 'X-Nimbus-Api-Key is required for repo registration', code: 'invalid_api_key' }, 400);
  }

  let payload: RegisterRepoRequest;
  try {
    payload = (await request.json()) as RegisterRepoRequest;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body', code: 'invalid_json' }, 400);
  }

  const repoSlug = typeof payload.repo_slug === 'string' ? normalizeRepoSlug(payload.repo_slug) : '';
  if (!REPO_SLUG_PATTERN.test(repoSlug)) {
    return jsonResponse({ error: 'repo_slug must be in owner/repo format', code: 'invalid_repo_slug' }, 400);
  }

  const existingAccount = await lookupRegistrationAccount(env, repoSlug);
  if (existingAccount) {
    if (existingAccount === authContext.accountId) {
      return jsonResponse({ repoSlug, accountId: authContext.accountId, status: 'already_registered' }, 200);
    }
    return jsonResponse(
      { error: 'Repository is already registered to another account', code: 'repo_already_registered' },
      409
    );
  }

  const now = new Date().toISOString();
  const keyHash = await sha256Hex(rawApiKey);

  try {
    await env.DB.prepare(
      'INSERT INTO nimbus_repo_registrations (repo_slug, account_id, created_at, registered_by_key_hash) VALUES (?, ?, ?, ?)'
    )
      .bind(repoSlug, authContext.accountId, now, keyHash)
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const winnerAccount = await lookupRegistrationAccount(env, repoSlug);
    if (winnerAccount === authContext.accountId) {
      return jsonResponse({ repoSlug, accountId: authContext.accountId, status: 'already_registered' }, 200);
    }
    return jsonResponse(
      { error: 'Repository is already registered to another account', code: 'repo_already_registered' },
      409
    );
  }

  return jsonResponse({ repoSlug, accountId: authContext.accountId, status: 'registered' }, 201);
}
