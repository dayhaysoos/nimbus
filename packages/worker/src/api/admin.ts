import type { AuthContext, Env } from '../types.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

interface CreateAdminKeyRequest {
  label: string;
  accountId?: string;
  isAdmin?: boolean;
}

interface CreateAdminKeyResponse {
  key: string;
  accountId: string;
  label: string;
  isAdmin: boolean;
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

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleCreateAdminApiKey(request: Request, env: Env, authContext: AuthContext): Promise<Response> {
  if (authContext.isHostedMode !== true) {
    return jsonResponse({ error: 'Not Found' }, 404);
  }
  if (authContext.isAdmin !== true) {
    return jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403);
  }

  let payload: CreateAdminKeyRequest;
  try {
    payload = (await request.json()) as CreateAdminKeyRequest;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body', code: 'invalid_json' }, 400);
  }

  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  if (!label) {
    return jsonResponse({ error: 'label is required', code: 'invalid_label' }, 400);
  }

  if (payload.isAdmin !== undefined && typeof payload.isAdmin !== 'boolean') {
    return jsonResponse({ error: 'isAdmin must be a boolean when provided', code: 'invalid_is_admin' }, 400);
  }

  const accountId = typeof payload.accountId === 'string' && payload.accountId.trim() ? payload.accountId.trim() : crypto.randomUUID();
  const isAdmin = payload.isAdmin === true;
  const key = `nmb_live_${randomHex(16)}`;
  const keyHash = await sha256Hex(key);
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO nimbus_api_keys (key_hash, account_id, label, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(keyHash, accountId, label, isAdmin ? 1 : 0, now)
    .run();

  const response: CreateAdminKeyResponse = {
    key,
    accountId,
    label,
    isAdmin,
  };

  return jsonResponse(response, 201);
}
