import type { Env } from '../../types.js';
import { OperationPreflightError } from './github-validation.js';

function base64UrlEncodeString(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }

  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function derWrap(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), encodeDerLength(body.length), body);
}

function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function convertPkcs1DerToPkcs8Der(pkcs1Der: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7,
    0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  );
  const privateKeyOctetString = derWrap(0x04, pkcs1Der);
  return derWrap(0x30, concatBytes(version, rsaAlgorithmIdentifier, privateKeyOctetString));
}

function decodePemBody(pem: string): { der: Uint8Array; type: 'pkcs8' | 'pkcs1' } {
  const normalized = pem.replace(/\r/g, '').trim();
  const pkcs8Match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (pkcs8Match?.[1]) {
    return { der: fromBase64(pkcs8Match[1]), type: 'pkcs8' };
  }

  const pkcs1Match = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/);
  if (pkcs1Match?.[1]) {
    return { der: fromBase64(pkcs1Match[1]), type: 'pkcs1' };
  }

  throw new OperationPreflightError(
    'configuration_invalid',
    'GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY) or PKCS#1 (BEGIN RSA PRIVATE KEY) PEM'
  );
}

export async function createGitHubAppJwt(env: Env): Promise<string> {
  if (env.GITHUB_APP_JWT && env.GITHUB_APP_JWT.trim()) {
    return env.GITHUB_APP_JWT.trim();
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new OperationPreflightError(
      'configuration_missing',
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub fork operations'
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  const payload = { iat: issuedAt, exp: issuedAt + 9 * 60, iss: env.GITHUB_APP_ID };
  const headerPart = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadPart = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;

  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
  let signaturePart: string;
  try {
    const decoded = decodePemBody(pem);
    const privateKeyDer = decoded.type === 'pkcs1' ? convertPkcs1DerToPkcs8Der(decoded.der) : decoded.der;
    const key = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyDer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
    signaturePart = base64UrlEncodeBytes(new Uint8Array(signature));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OperationPreflightError('configuration_invalid', `Invalid GitHub App private key: ${message}`);
  }

  return `${signingInput}.${signaturePart}`;
}
