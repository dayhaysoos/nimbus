import type { Env } from '../types.js';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
const JWKS_CACHE_KEY = 'github_oidc_jwks';
const JWKS_CACHE_TTL_SECONDS = 3600;
const DEFAULT_NIMBUS_TOKEN_TTL_SECONDS = 1800;
const CLOCK_SKEW_SECONDS = 60;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

interface ExchangeRequest {
  token: string;
}

interface JwkKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface JwksDocument {
  keys: JwkKey[];
}

interface OidcClaims {
  iss?: unknown;
  aud?: unknown;
  repository?: unknown;
  exp?: unknown;
}

function normalizeRepoSlug(repoSlug: string): string {
  return repoSlug.trim().toLowerCase();
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

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractAudiences(aud: unknown): string[] {
  if (typeof aud === 'string' && aud.trim()) {
    return [aud.trim()];
  }
  if (!Array.isArray(aud)) {
    return [];
  }
  return aud
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function loadGithubJwks(env: Env, options?: { forceRefresh?: boolean }): Promise<JwksDocument> {
  if (env.OIDC_CACHE && options?.forceRefresh !== true) {
    const cached = await env.OIDC_CACHE.get(JWKS_CACHE_KEY);
    if (cached) {
      const parsed = parseJson<JwksDocument>(cached);
      if (parsed && Array.isArray(parsed.keys)) {
        return parsed;
      }
    }
  }

  const response = await fetch(GITHUB_OIDC_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub JWKS (${response.status})`);
  }

  const raw = await response.text();
  const parsed = parseJson<JwksDocument>(raw);
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error('GitHub JWKS response was invalid');
  }

  if (env.OIDC_CACHE) {
    await env.OIDC_CACHE.put(JWKS_CACHE_KEY, raw, {
      expirationTtl: JWKS_CACHE_TTL_SECONDS,
    });
  }

  return parsed;
}

async function verifyGithubOidcToken(token: string, env: Env): Promise<{ repository: string } | null> {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  let header: Record<string, unknown> | null = null;
  let payload: OidcClaims | null = null;
  try {
    const headerRaw = new TextDecoder().decode(base64UrlDecodeToBytes(encodedHeader));
    const payloadRaw = new TextDecoder().decode(base64UrlDecodeToBytes(encodedPayload));
    header = parseJson<Record<string, unknown>>(headerRaw);
    payload = parseJson<OidcClaims>(payloadRaw);
  } catch {
    return null;
  }
  if (!header || !payload) {
    return null;
  }

  const alg = typeof header.alg === 'string' ? header.alg : '';
  const kid = typeof header.kid === 'string' ? header.kid : '';
  if (alg !== 'RS256' || !kid) {
    return null;
  }

  let jwks = await loadGithubJwks(env);
  let jwk = jwks.keys.find((key) => key.kid === kid && key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string');
  if (!jwk) {
    jwks = await loadGithubJwks(env, { forceRefresh: true });
    jwk = jwks.keys.find((key) => key.kid === kid && key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string');
  }
  if (!jwk || !jwk.n || !jwk.e) {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'RSA',
      use: 'sig',
      alg: 'RS256',
      n: jwk.n,
      e: jwk.e,
      ext: true,
    },
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify']
  );

  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlDecodeToBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    );
  } catch {
    return null;
  }
  if (!verified) {
    return null;
  }

  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  if (issuer !== GITHUB_OIDC_ISSUER) {
    return null;
  }

  const audiences = extractAudiences(payload.aud);
  if (!audiences.includes('nimbus')) {
    return null;
  }

  const repository = typeof payload.repository === 'string' ? normalizeRepoSlug(payload.repository) : '';
  if (!repository) {
    return null;
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : Number(payload.exp);
  if (!Number.isFinite(exp)) {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > Math.floor(exp) + CLOCK_SKEW_SECONDS) {
    return null;
  }

  return { repository };
}

async function mintNimbusJwt(accountId: string, secret: string): Promise<string> {
  const ttlSeconds = getNimbusTokenTtlSeconds();
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncodeText(
    JSON.stringify({
      accountId,
      iat: nowSec,
      exp: nowSec + ttlSeconds,
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `nmb_jwt_${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function getNimbusTokenTtlSeconds(): number {
  return DEFAULT_NIMBUS_TOKEN_TTL_SECONDS;
}

export async function handleAuthExchange(request: Request, env: Env): Promise<Response> {
  let payload: ExchangeRequest;
  try {
    payload = (await request.json()) as ExchangeRequest;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body', code: 'invalid_json' }, 400);
  }

  const token = typeof payload.token === 'string' ? payload.token.trim() : '';
  if (!token) {
    return jsonResponse({ error: 'token is required', code: 'invalid_token' }, 400);
  }

  const tokenSecret = typeof env.NIMBUS_TOKEN_SECRET === 'string' ? env.NIMBUS_TOKEN_SECRET.trim() : '';
  if (!tokenSecret) {
    return jsonResponse({ error: 'Token exchange is not configured', code: 'exchange_not_configured' }, 500);
  }

  let verified: { repository: string } | null = null;
  try {
    verified = await verifyGithubOidcToken(token, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[auth-exchange] verification failed: ${message}`);
    return jsonResponse({ error: 'OIDC verification failed', code: 'oidc_verification_failed' }, 401);
  }
  if (!verified) {
    return jsonResponse({ error: 'Invalid OIDC token', code: 'invalid_oidc_token' }, 401);
  }

  const repoSlug = normalizeRepoSlug(verified.repository);

  const registration = await env.DB.prepare('SELECT account_id FROM nimbus_repo_registrations WHERE repo_slug = ?')
    .bind(repoSlug)
    .first<{ account_id: string }>();
  if (!registration?.account_id) {
    return jsonResponse(
      { error: 'Repository is not registered for Nimbus OIDC exchange', code: 'repo_not_registered' },
      403
    );
  }

  const mintedToken = await mintNimbusJwt(registration.account_id, tokenSecret);
  return jsonResponse({ token: mintedToken, expiresInSeconds: getNimbusTokenTtlSeconds() }, 200);
}

export async function handleAuthExchangeHealth(_request: Request, env: Env): Promise<Response> {
  const tokenSecretConfigured = typeof env.NIMBUS_TOKEN_SECRET === 'string' && env.NIMBUS_TOKEN_SECRET.trim().length > 0;
  const oidcCacheBindingConfigured = Boolean(env.OIDC_CACHE);

  let oidcCacheWarm: boolean | null = null;
  if (env.OIDC_CACHE) {
    try {
      oidcCacheWarm = (await env.OIDC_CACHE.get(JWKS_CACHE_KEY)) !== null;
    } catch {
      oidcCacheWarm = null;
    }
  }

  return jsonResponse(
    {
      exchangeReady: tokenSecretConfigured,
      tokenSecretConfigured,
      oidcCacheBindingConfigured,
      oidcCacheWarm,
      jwksCacheTtlSeconds: JWKS_CACHE_TTL_SECONDS,
      tokenTtlSeconds: getNimbusTokenTtlSeconds(),
    },
    200
  );
}
