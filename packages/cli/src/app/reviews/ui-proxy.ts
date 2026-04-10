import { once } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import { startStudioNewReview } from './studio-create.js';
import { getStudioNewReviewPreflightCached } from './studio-preflight-cache.js';
import { createProxyHeaders } from './ui-events-fanout.js';

const LOCAL_HOST = '127.0.0.1';
const STUDIO_CONTEXT_PATH = '/api/studio/context';
const STUDIO_NEW_REVIEW_PREFLIGHT_PATH = '/api/studio/new-review/preflight';
const STUDIO_NEW_REVIEW_START_PATH = '/api/studio/new-review/start';
const STUDIO_NEW_REVIEW_START_EVENTS_PATH = '/api/studio/new-review/start/events';

let startStudioNewReviewForUiProxy: typeof startStudioNewReview = startStudioNewReview;

function parseLastCheckpoints(value: unknown): 1 | 2 | 3 {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3) {
    return value as 1 | 2 | 3;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3) {
      return parsed as 1 | 2 | 3;
    }
  }
  return 2;
}

function resolveRepoRootSafe(): string | undefined {
  try {
    return new GitRepo(process.cwd()).getRepoRoot();
  } catch {
    return undefined;
  }
}

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

function writeSseFrame(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function setUiProxyHooksForTests(
  overrides: {
    startStudioNewReview?: typeof startStudioNewReview;
  } | null
): void {
  startStudioNewReviewForUiProxy = overrides?.startStudioNewReview ?? startStudioNewReview;
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
  if (requestUrl.pathname === STUDIO_CONTEXT_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    let repo: string | null = null;
    let branch: string | null = null;
    try {
      repo = detectRepoSlugFromGitOrigin();
    } catch {
      repo = null;
    }
    try {
      branch = new GitRepo(process.cwd()).getCurrentBranchRef();
    } catch {
      branch = null;
    }

    const payload = {
      repo,
      branch,
      detectedAt: new Date().toISOString(),
    };
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (method === 'HEAD') {
      response.end();
      return true;
    }
    response.end(JSON.stringify(payload));
    return true;
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_PREFLIGHT_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    try {
      const payload = await getStudioNewReviewPreflightCached({
        repoRoot: resolveRepoRootSafe(),
        lastCheckpoints: parseLastCheckpoints(requestUrl.searchParams.get('lastCheckpoints')),
      });
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (method === 'HEAD') {
        response.end();
        return true;
      }
      response.end(JSON.stringify(payload));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: `Failed to load Studio preflight: ${message}` }));
      return true;
    }
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_START_PATH) {
    const method = (request.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body.toString('utf8')) as {
        policyMode?: unknown;
        repo?: unknown;
        branch?: unknown;
        lastCheckpoints?: unknown;
      };
      const policyMode = payload?.policyMode;
      if (policyMode !== 'auto' && policyMode !== 'review') {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Invalid policyMode. Use auto or review.' }));
        return true;
      }

      const expectedRepo = typeof payload.repo === 'string' ? payload.repo : null;
      const expectedBranch = typeof payload.branch === 'string' ? payload.branch : null;
      const started = await startStudioNewReviewForUiProxy({
        policyMode,
        lastCheckpoints: parseLastCheckpoints(payload.lastCheckpoints),
        repoRoot: resolveRepoRootSafe(),
        expectedRepo,
        expectedBranch,
      });
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(started));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: `Failed to start review: ${message}` }));
      return true;
    }
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_START_EVENTS_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const policyMode = requestUrl.searchParams.get('policyMode');
    if (policyMode !== 'auto' && policyMode !== 'review') {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Invalid policyMode. Use auto or review.' }));
      return true;
    }

    const expectedRepo = requestUrl.searchParams.get('repo');
    const expectedBranch = requestUrl.searchParams.get('branch');
    const lastCheckpoints = parseLastCheckpoints(requestUrl.searchParams.get('lastCheckpoints'));
    let streamOpen = true;
    const abortController = new AbortController();
    response.on('close', () => {
      streamOpen = false;
      abortController.abort();
    });
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.flushHeaders?.();

    try {
      await startStudioNewReviewForUiProxy({
        policyMode,
        lastCheckpoints,
        repoRoot: resolveRepoRootSafe(),
        expectedRepo,
        expectedBranch,
        signal: abortController.signal,
        onEvent: async (event) => {
          if (!streamOpen || abortController.signal.aborted) {
            return;
          }
          try {
            writeSseFrame(response, event);
          } catch {
            streamOpen = false;
            abortController.abort();
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamOpen) {
        writeSseFrame(response, {
          type: 'error',
          message: `Failed to start review: ${message}`,
        });
      }
    } finally {
      if (streamOpen) {
        response.end();
      }
    }
    return true;
  }

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

  const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await readBody(request));
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
