import * as p from '@clack/prompts';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { createReadStream, statSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { dirname, extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { deriveReviewPolicy, getReview, getWorkerUrl, streamReviewEvents } from '../../lib/api.js';
import { formatEvent } from './events.js';
import { resolveReviewContext } from './create.js';

const DEFAULT_OPEN_PORT = 2000;
const LOCAL_HOST = '127.0.0.1';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const REPORT_UI_MARKER = 'nimbus-report-ui';
const REPORT_UI_HEALTH_PATH = '/__nimbus/report-ui-health';
const REPORT_UI_PROBE_TIMEOUT_MS = 1200;

interface UiServerSession {
  appUrl: string;
  close: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

export interface OpenReviewFromCommitOptions {
  port?: number;
  commitish?: string;
  baseRef?: string;
  projectRoot?: string;
  idempotencyKey?: string;
  pollIntervalMs?: number;
}

export interface StartReviewUiOptions {
  port?: number;
}

interface ExistingReportUiServer {
  appUrl: string;
  source: 'health' | 'html-marker';
  workerUrl: string | null;
  authFingerprint: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeRoutePath(routePath: string): string {
  if (!routePath.trim()) {
    return '/';
  }
  return routePath.startsWith('/') ? routePath : `/${routePath}`;
}

function buildAppUrl(port: number, routePath: string): string {
  return `http://${LOCAL_HOST}:${port}${normalizeRoutePath(routePath)}`;
}

function resolveUiPort(port: number | undefined): number {
  const resolved = port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }
  return resolved;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildProxyAuthFingerprint(options: {
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}): string {
  const payload = JSON.stringify({
    apiKey: options.apiKey ?? '',
    reviewGithubToken: options.reviewGithubToken ?? '',
    openrouterApiKey: options.openrouterApiKey ?? '',
  });
  return createHash('sha256').update(payload).digest('hex');
}

function validateExistingServerCompatibility(
  existingServer: ExistingReportUiServer,
  expectedWorkerUrl: string,
  expectedAuthFingerprint: string
): { reusable: boolean; reason?: string } {
  if (existingServer.source !== 'health') {
    return {
      reusable: false,
      reason: 'detected an older server that does not expose compatibility metadata',
    };
  }
  if (!existingServer.workerUrl || existingServer.workerUrl !== expectedWorkerUrl) {
    return {
      reusable: false,
      reason: 'server is configured for a different NIMBUS_WORKER_URL',
    };
  }
  if (!existingServer.authFingerprint || existingServer.authFingerprint !== expectedAuthFingerprint) {
    return {
      reusable: false,
      reason: 'server was started with different proxy auth headers',
    };
  }
  return { reusable: true };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function ensureFilePath(rootDir: string, requestPath: string): string | null {
  const normalizedRoot = resolve(rootDir);
  const candidate = resolve(normalizedRoot, `.${requestPath}`);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveStaticEntry(distDir: string, rawPathname: string): string | null {
  let pathname = rawPathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }

  const indexPath = join(distDir, 'index.html');
  if (pathname === '/' || pathname.startsWith('/reports/') || pathname.startsWith('/policy/')) {
    return fileExists(indexPath) ? indexPath : null;
  }

  const directFile = ensureFilePath(distDir, pathname);
  if (directFile && fileExists(directFile)) {
    return directFile;
  }

  if (!extname(pathname) && fileExists(indexPath)) {
    return indexPath;
  }

  return null;
}

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
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

async function proxyApiRequest(
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
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (!value) {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  if (apiKey) {
    headers.set('X-Nimbus-Api-Key', apiKey);
  }
  if (reviewGithubToken) {
    headers.set('X-Review-Github-Token', reviewGithubToken);
  }
  if (openrouterApiKey) {
    headers.set('X-Openrouter-Api-Key', openrouterApiKey);
  }

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

async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    distDir: string;
    workerUrl: string;
    apiKey: string | null;
    reviewGithubToken: string | null;
    openrouterApiKey: string | null;
  }
): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_HOST}`);
    if (requestUrl.pathname === REPORT_UI_HEALTH_PATH) {
      const method = (request.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end('Method not allowed');
        return;
      }

      const body = JSON.stringify({
        service: REPORT_UI_MARKER,
        host: LOCAL_HOST,
        workerUrl: options.workerUrl,
        authFingerprint: buildProxyAuthFingerprint({
          apiKey: options.apiKey,
          reviewGithubToken: options.reviewGithubToken,
          openrouterApiKey: options.openrouterApiKey,
        }),
      });
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
      if (method === 'HEAD') {
        response.end();
        return;
      }
      response.end(body);
      return;
    }

    const proxied = await proxyApiRequest(
      request,
      response,
      options.workerUrl,
      options.apiKey,
      options.reviewGithubToken,
      options.openrouterApiKey
    );
    if (proxied) {
      return;
    }

    const staticPath = resolveStaticEntry(options.distDir, requestUrl.pathname);
    if (!staticPath) {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Not found');
      return;
    }

    const stats = statSync(staticPath);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeFor(staticPath));
    response.setHeader('Content-Length', String(stats.size));
    if ((request.method ?? 'GET').toUpperCase() === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(staticPath)
      .on('error', () => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        response.end('Failed to read static file.');
      })
      .pipe(response);
  } catch (error) {
    response.statusCode = 502;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(error instanceof Error ? error.message : 'Proxy error');
  }
}

async function startStaticServer(options: {
  distDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<Server> {
  const server = createServer((request, response) => {
    void handleStaticRequest(request, response, {
      distDir: options.distDir,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once('error', onError);
    server.listen(options.port, LOCAL_HOST, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  return server;
}

function resolvePackagedDistDir(): string | null {
  const bundled = resolve(MODULE_DIR, '..', '..', '..', 'assets', 'report-ui');
  if (fileExists(join(bundled, 'index.html'))) {
    return bundled;
  }
  return null;
}

function resolveMonorepoDistDir(): string | null {
  const candidates = [
    resolve(process.cwd(), 'packages', 'report-ui', 'dist'),
    resolve(MODULE_DIR, '..', '..', '..', '..', 'report-ui', 'dist'),
  ];
  for (const candidate of candidates) {
    if (fileExists(join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

function resolveMonorepoReportUiDir(): string | null {
  const candidates = [
    resolve(process.cwd(), 'packages', 'report-ui'),
    resolve(MODULE_DIR, '..', '..', '..', '..', 'report-ui'),
  ];
  for (const candidate of candidates) {
    if (fileExists(join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

async function waitForServer(url: string, server: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error('Report UI server exited before becoming ready.');
    }

    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.status < 500) {
        return;
      }
    } catch {
      // keep polling until ready or timeout
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for report UI server at ${url}`);
}

async function probeExistingReportUiServer(port: number): Promise<ExistingReportUiServer | null> {
  const rootUrl = buildAppUrl(port, '/');
  const healthUrl = buildAppUrl(port, REPORT_UI_HEALTH_PATH);

  try {
    const healthResponse = await fetchWithTimeout(
      healthUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
      REPORT_UI_PROBE_TIMEOUT_MS
    );
    if (healthResponse.ok) {
      const payload = (await healthResponse.json().catch(() => null)) as Record<string, unknown> | null;
      if (payload && payload.service === REPORT_UI_MARKER) {
        return {
          appUrl: rootUrl,
          source: 'health',
          workerUrl: typeof payload.workerUrl === 'string' ? payload.workerUrl : null,
          authFingerprint: typeof payload.authFingerprint === 'string' ? payload.authFingerprint : null,
        };
      }
    }
  } catch {
    // Fall through to HTML marker probing.
  }

  try {
    const rootResponse = await fetchWithTimeout(
      rootUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html',
        },
      },
      REPORT_UI_PROBE_TIMEOUT_MS
    );
    if (!rootResponse.ok) {
      return null;
    }
    const html = await rootResponse.text();
    const markerToken = `name="${REPORT_UI_MARKER}"`;
    if (!html.includes(markerToken)) {
      return null;
    }
    return {
      appUrl: rootUrl,
      source: 'html-marker',
      workerUrl: null,
      authFingerprint: null,
    };
  } catch {
    return null;
  }
}

async function startDevServerSession(options: {
  routePath: string;
  reportUiDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<UiServerSession> {
  const appUrl = buildAppUrl(options.port, options.routePath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NIMBUS_API_PROXY_TARGET: options.workerUrl,
    VITE_HOST: LOCAL_HOST,
    VITE_PORT: String(options.port),
  };
  env.NIMBUS_REPORT_UI_HEALTH_WORKER_URL = options.workerUrl;
  env.NIMBUS_REPORT_UI_HEALTH_AUTH_FINGERPRINT = buildProxyAuthFingerprint({
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
  });
  delete env.VITE_NIMBUS_API_BASE_URL;

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const serverArgs = ['dev'];

  p.log.message(`Starting report UI dev server on ${LOCAL_HOST}:${options.port} with API proxy target ${options.workerUrl}`);

  const server = spawn(pnpmCommand, serverArgs, {
    cwd: options.reportUiDir,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk: Buffer | string) => {
    process.stdout.write(chunk);
  });
  server.stderr.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

  const serverExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    server.once('error', rejectExit);
    server.once('exit', (code, signal) => {
      resolveExit({ code, signal });
    });
  });

  await waitForServer(`http://${LOCAL_HOST}:${options.port}/`, server, 30_000);

  return {
    appUrl,
    close: async () => {
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([serverExit.catch(() => undefined), sleep(2000)]);
      }
      if (server.exitCode === null) {
        server.kill('SIGKILL');
      }
    },
    waitForExit: async () => {
      const exit = await serverExit;
      const signalSuffix = exit.signal ? ` (signal ${exit.signal})` : '';
      throw new Error(`Report UI server exited unexpectedly with code ${exit.code ?? 'null'}${signalSuffix}.`);
    },
  };
}

async function startStaticServerSession(options: {
  routePath: string;
  distDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<UiServerSession> {
  const appUrl = buildAppUrl(options.port, options.routePath);
  const server = await startStaticServer({
    distDir: options.distDir,
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
    port: options.port,
  });

  return {
    appUrl,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
    waitForExit: async () => {
      await new Promise<void>((_resolve, rejectWait) => {
        if (!server.listening) {
          rejectWait(new Error('Report UI server stopped unexpectedly.'));
          return;
        }
        const onClose = () => {
          server.off('error', onError);
          rejectWait(new Error('Report UI server stopped unexpectedly.'));
        };
        const onError = (error: Error) => {
          server.off('close', onClose);
          rejectWait(error);
        };
        server.once('close', onClose);
        server.once('error', onError);
      });
    },
  };
}

async function startReportUiSession(options: {
  routePath: string;
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}): Promise<UiServerSession> {
  const reportUiDir = resolveMonorepoReportUiDir();
  if (reportUiDir) {
    return startDevServerSession({
      routePath: options.routePath,
      reportUiDir,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
      port: options.port,
    });
  }

  const bundledDistDir = resolvePackagedDistDir();
  if (bundledDistDir) {
    p.log.message(
      `Serving report UI assets from ${bundledDistDir} on ${LOCAL_HOST}:${options.port} with API proxy target ${options.workerUrl}`
    );
    return startStaticServerSession({
      routePath: options.routePath,
      distDir: bundledDistDir,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
      port: options.port,
    });
  }

  throw new Error('Unable to locate monorepo report-ui package or bundled assets. Reinstall or rebuild the CLI package.');
}

export async function openReviewFromCommitCommand(options?: OpenReviewFromCommitOptions): Promise<void> {
  const port = resolveUiPort(options?.port);

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  const expectedAuthFingerprint = buildProxyAuthFingerprint({
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });
  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  const existingServer = await probeExistingReportUiServer(port);
  if (existingServer) {
    const compatibility = validateExistingServerCompatibility(existingServer, workerUrl, expectedAuthFingerprint);
    if (!compatibility.reusable) {
      throw new Error(
        `Report UI server already running on ${LOCAL_HOST}:${port} but cannot be reused: ${compatibility.reason}. Stop the existing server or use a different --port.`
      );
    }
    p.log.message(`Detected running report UI server on ${LOCAL_HOST}:${port}; reusing existing session.`);
  }

  const context = await resolveReviewContext({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
  });

  p.log.message(`Starting policy derivation for workspace ${context.workspaceId}, deployment ${context.deploymentId}`);
  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId: context.workspaceId,
    deploymentId: context.deploymentId,
    provenance: context.resolvedProvenance,
  });

  const policyPath = `/policy/${encodeURIComponent(derived.reviewId)}`;
  const policyUrl = buildAppUrl(port, policyPath);
  if (existingServer) {
    openBrowser(policyUrl);
    p.log.success(`Opened ${policyUrl}`);
    p.log.message('Policy draft is ready in the browser. Approve it there to start review execution.');
    return;
  }

  const uiSession = await startReportUiSession({
    routePath: policyPath,
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });
  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Streaming review events; press Ctrl+C to stop.');

  let terminalStatus: string | null = null;
  let interrupted = false;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await uiSession.close().catch(() => undefined);
  };
  const handleSignal = () => {
    interrupted = true;
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    const proxyWorkerUrl = `http://${LOCAL_HOST}:${port}`;
    await Promise.race([
      streamReviewEvents(proxyWorkerUrl, derived.reviewId, async (event) => {
        const line = formatEvent(event);
        if (line) {
          console.log(line);
        }
        if (event.data.type === 'terminal' && typeof event.data.status === 'string') {
          terminalStatus = event.data.status;
        }
      }),
      uiSession.waitForExit(),
    ]);

    if (interrupted) {
      return;
    }

    const final = await getReview(proxyWorkerUrl, derived.reviewId);
    const status = terminalStatus ?? final.review.status;
    if (status === 'succeeded') {
      p.log.success(`Review completed: ${status}`);
    } else {
      p.log.warning(`Review completed: ${status}`);
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
    p.outro('Report UI stopped.');
  }
}

export async function startReviewUiCommand(options?: StartReviewUiOptions): Promise<void> {
  const port = resolveUiPort(options?.port);
  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  const expectedAuthFingerprint = buildProxyAuthFingerprint({
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });

  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  const existingServer = await probeExistingReportUiServer(port);
  if (existingServer) {
    const compatibility = validateExistingServerCompatibility(existingServer, workerUrl, expectedAuthFingerprint);
    if (!compatibility.reusable) {
      throw new Error(
        `Report UI server already running on ${LOCAL_HOST}:${port} but cannot be reused: ${compatibility.reason}. Stop the existing server or use a different --port.`
      );
    }
    openBrowser(existingServer.appUrl);
    p.log.success(`Opened ${existingServer.appUrl}`);
    p.log.message(`Report UI server is already running on ${LOCAL_HOST}:${port}.`);
    return;
  }

  const uiSession = await startReportUiSession({
    routePath: '/',
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });

  openBrowser(uiSession.appUrl);
  p.log.success(`Opened ${uiSession.appUrl}`);
  p.log.message('Report UI server running; press Ctrl+C to stop.');

  let interrupted = false;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await uiSession.close().catch(() => undefined);
  };
  const handleSignal = () => {
    interrupted = true;
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await uiSession.waitForExit();
  } catch (error) {
    if (!interrupted) {
      throw error;
    }
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
    p.outro('Report UI stopped.');
  }
}
