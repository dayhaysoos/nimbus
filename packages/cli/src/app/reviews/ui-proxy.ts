import { once } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { createProxyHeaders } from './ui-events-fanout.js';

const LOCAL_HOST = '127.0.0.1';

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

export async function proxyApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workerUrl: string,
  apiKey: string | null,
  reviewGithubToken: string | null,
  openrouterApiKey: string | null
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_HOST}`);
  if (!(requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/'))) {
    return false;
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, workerUrl);
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = createProxyHeaders(request.headers, {
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });

  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request);
  const upstream = await fetch(targetUrl.toString(), {
    method,
    headers,
    body,
  });

  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return;
    }
    response.setHeader(key, value);
  });

  if (!upstream.body || method === 'HEAD') {
    response.end();
    return true;
  }

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    if (!response.write(Buffer.from(value))) {
      await once(response, 'drain');
    }
  }
  response.end();
  return true;
}
