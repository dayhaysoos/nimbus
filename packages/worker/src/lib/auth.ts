import type { AuthContext, Env } from '../types.js';

const DEFAULT_ACCOUNT_ID = 'self-hosted';

interface ApiKeyRecord {
  account_id: string;
  is_admin: number;
}

interface NimbusTokenClaims {
  accountId?: unknown;
  exp?: unknown;
}

function isHostedMode(env: Env): boolean {
  return env.NIMBUS_HOSTED === 'true';
}

export function createSelfHostedAuthContext(): AuthContext {
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    isAdmin: true,
    isAuthenticated: false,
    isHostedMode: false,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'API key required', code: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
    },
  });
}

async function lookupApiKey(env: Env, keyHash: string): Promise<ApiKeyRecord | null> {
  return (await env.DB.prepare('SELECT account_id, is_admin FROM nimbus_api_keys WHERE key_hash = ?')
    .bind(keyHash)
    .first<ApiKeyRecord>()) ?? null;
}

function isPublicApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) {
    return true;
  }
  return (
    pathname === '/api/system/deploy-readiness' ||
    pathname === '/api/system/review-readiness' ||
    pathname === '/api/auth/exchange'
  );
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  const decoded = atob(padded);
  const output = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    output[i] = decoded.charCodeAt(i);
  }
  return output;
}

async function verifyNimbusJwt(token: string, env: Env): Promise<{ accountId: string } | null> {
  const secret = typeof env.NIMBUS_TOKEN_SECRET === 'string' ? env.NIMBUS_TOKEN_SECRET.trim() : '';
  if (!secret) {
    return null;
  }

  try {
    const segments = token.split('.');
    if (segments.length !== 3) {
      return null;
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const headerText = new TextDecoder().decode(base64UrlDecodeToBytes(encodedHeader));
    const header = JSON.parse(headerText) as { alg?: unknown; typ?: unknown };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null;
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecodeToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
    if (!isValid) {
      return null;
    }

    const payloadText = new TextDecoder().decode(base64UrlDecodeToBytes(encodedPayload));
    const claims = JSON.parse(payloadText) as NimbusTokenClaims;

    const accountId = typeof claims.accountId === 'string' ? claims.accountId.trim() : '';
    const exp = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp);
    if (!accountId || !Number.isFinite(exp)) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec > Math.floor(exp)) {
      return null;
    }

    return { accountId };
  } catch {
    return null;
  }
}

export async function authenticateRequest(request: Request, env: Env): Promise<{ authContext: AuthContext } | { response: Response }> {
  if (!isHostedMode(env)) {
    return { authContext: createSelfHostedAuthContext() };
  }

  const pathname = new URL(request.url).pathname;
  if (isPublicApiPath(pathname)) {
    return {
      authContext: {
        accountId: DEFAULT_ACCOUNT_ID,
        isAdmin: false,
        isAuthenticated: false,
        isHostedMode: true,
      },
    };
  }

  const apiKey = request.headers.get('X-Nimbus-Api-Key')?.trim();
  if (!apiKey) {
    return { response: unauthorizedResponse() };
  }

  if (apiKey.startsWith('nmb_jwt_')) {
    const token = apiKey.slice('nmb_jwt_'.length);
    const verified = await verifyNimbusJwt(token, env);
    if (!verified) {
      return { response: unauthorizedResponse() };
    }
    return {
      authContext: {
        accountId: verified.accountId,
        isAdmin: false,
        isAuthenticated: true,
        isHostedMode: true,
      },
    };
  }

  const keyHash = await sha256Hex(apiKey);
  const record = await lookupApiKey(env, keyHash);
  if (!record) {
    return { response: unauthorizedResponse() };
  }

  const now = new Date().toISOString();
  env.DB.prepare('UPDATE nimbus_api_keys SET last_used_at = ? WHERE key_hash = ?')
    .bind(now, keyHash)
    .run()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[auth] failed to update key last_used_at: ${message}`);
    });

  return {
    authContext: {
      accountId: record.account_id,
      isAdmin: record.is_admin === 1,
      isAuthenticated: true,
      isHostedMode: true,
    },
  };
}
