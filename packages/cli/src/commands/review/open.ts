import * as p from '@clack/prompts';
import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import { createReadStream, statSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { dirname, extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { deriveReviewPolicy, getWorkerUrl, getWorkspace } from '../../lib/api.js';
import { resolveEntireIntentContextForCommit } from '../../lib/entire/context.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
  if (pathname === '/' || pathname.startsWith('/reports/')) {
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

    const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_HOST}`);
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

async function runDevServer(options: {
  routePath: string;
  reportUiDir: string;
  workerUrl: string;
  port: number;
}): Promise<void> {
  const appUrl = `http://${LOCAL_HOST}:${options.port}${options.routePath}`;
  const env: NodeJS.ProcessEnv = { ...process.env, NIMBUS_API_PROXY_TARGET: options.workerUrl };
  delete env.VITE_NIMBUS_API_BASE_URL;

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const serverArgs = [
    'dev',
    '--',
    '--host',
    LOCAL_HOST,
    '--port',
    String(options.port),
    '--strictPort',
  ];

  p.log.message(
    `Starting report UI dev server on ${LOCAL_HOST}:${options.port} with API proxy target ${options.workerUrl}`
  );

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

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.kill(signal);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await waitForServer(`http://${LOCAL_HOST}:${options.port}/`, server, 30_000);
    openBrowser(appUrl);
    p.log.success(`Opened ${appUrl}`);
    p.log.message('Press Ctrl+C to stop the local report UI.');

    const exit = await serverExit;
    if (shuttingDown) {
      p.outro('Report UI stopped.');
      return;
    }

    const signalSuffix = exit.signal ? ` (signal ${exit.signal})` : '';
    throw new Error(`Report UI server exited unexpectedly with code ${exit.code ?? 'null'}${signalSuffix}.`);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([serverExit.catch(() => undefined), sleep(2000)]);
      if (server.exitCode === null) {
        server.kill('SIGKILL');
      }
    }
  }
}

async function runStaticServer(options: {
  routePath: string;
  distDir: string;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  port: number;
}): Promise<void> {
  const appUrl = `http://${LOCAL_HOST}:${options.port}${options.routePath}`;
  const server = await startStaticServer({
    distDir: options.distDir,
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
    port: options.port,
  });

  p.log.message(
    `Serving report UI assets from ${options.distDir} on ${LOCAL_HOST}:${options.port} with API proxy target ${options.workerUrl}`
  );

  openBrowser(appUrl);
  p.log.success(`Opened ${appUrl}`);
  p.log.message('Press Ctrl+C to stop the local report UI.');

  let shutdownRequested = false;
  const closeServer = async (): Promise<void> => {
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
  };

  let resolveWait!: () => void;
  let rejectWait!: (error: Error) => void;
  const waitForShutdown = new Promise<void>((resolveWaitPromise, rejectWaitPromise) => {
    resolveWait = resolveWaitPromise;
    rejectWait = (error: Error) => rejectWaitPromise(error);
  });

  const handleSignal = () => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    void closeServer()
      .then(() => resolveWait())
      .catch((error) => {
        rejectWait(error instanceof Error ? error : new Error(String(error)));
      });
  };

  const handleUnexpectedClose = () => {
    if (shutdownRequested) {
      resolveWait();
      return;
    }
    rejectWait(new Error('Report UI server stopped unexpectedly.'));
  };

  const handleServerError = (error: Error) => {
    rejectWait(error);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  server.once('close', handleUnexpectedClose);
  server.once('error', handleServerError);

  try {
    await waitForShutdown;
    p.outro('Report UI stopped.');
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    server.off('close', handleUnexpectedClose);
    server.off('error', handleServerError);
    if (server.listening) {
      await closeServer().catch(() => undefined);
    }
  }
}

function resolveRepositorySlug(): string | null {
  const explicit = process.env.NIMBUS_REPO_SLUG?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    }).trim();
    const normalized = remoteUrl.replace(/^git\+/, '').replace(/\.git$/i, '').trim();
    if (!normalized) {
      return null;
    }

    const scpLikeSshMatch = normalized.match(/^git@([^:]+):([^/]+\/[^/]+)$/i);
    if (scpLikeSshMatch) {
      const host = (scpLikeSshMatch[1] ?? '').toLowerCase();
      if (host !== 'github.com') {
        return null;
      }
      return (scpLikeSshMatch[2] ?? '').trim() || null;
    }

    if (/^https?:\/\//i.test(normalized) || /^ssh:\/\//i.test(normalized)) {
      const parsed = new URL(normalized);
      if (parsed.hostname.toLowerCase() !== 'github.com') {
        return null;
      }
      const segments = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
      if (segments.length < 2) {
        return null;
      }
      return `${segments[0]}/${segments[1]}`;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveCurrentBranch(): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function openReportUiRoute(options: {
  routePath: string;
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}): Promise<void> {
  const bundledDistDir = resolvePackagedDistDir();
  const monorepoDistDir = resolveMonorepoDistDir();
  const distDir = bundledDistDir ?? monorepoDistDir;

  if (distDir) {
    await runStaticServer({
      routePath: options.routePath,
      distDir,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
      port: options.port,
    });
    return;
  }

  const reportUiDir = resolveMonorepoReportUiDir();
  if (!reportUiDir) {
    throw new Error('Unable to locate bundled report UI assets or monorepo report-ui package. Reinstall or rebuild the CLI package.');
  }

  await runDevServer({
    routePath: options.routePath,
    reportUiDir,
    workerUrl: options.workerUrl,
    port: options.port,
  });
}

export async function openReviewCommand(
  reviewId: string,
  options?: { port?: number }
): Promise<void> {
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;

  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  await openReportUiRoute({
    routePath: `/reports/${encodeURIComponent(reviewId)}`,
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });
}

export async function startPolicyReviewOpenCommand(
  workspaceId: string,
  deploymentId: string,
  options?: { port?: number }
): Promise<void> {
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? null;
  if (!apiKey) {
    p.log.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  const workspace = await getWorkspace(workerUrl, workspaceId);
  const provenance: Record<string, unknown> = {
    trigger: 'manual_cli',
    commitSha: workspace.commitSha,
  };
  const repo = resolveRepositorySlug();
  if (repo) {
    provenance.repo = repo;
  }
  const branch = resolveCurrentBranch();
  if (branch) {
    provenance.branch = branch;
  }

  if (workspace.checkpointId) {
    try {
      const entire = await resolveEntireIntentContextForCommit(workspace.commitSha, process.cwd(), {
        summarizeSession: 'auto',
        checkpointId: workspace.checkpointId,
      });
      provenance.note = entire.note;
      provenance.transcriptUrl = entire.transcriptUrl;
      provenance.sessionIds = entire.sessionIds;
      provenance.intentSessionContext = entire.intentSessionContext;
      provenance.rawSessionPrompts = entire.rawSessionPrompts ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      p.log.warning(`Entire intent context unavailable for policy derivation: ${message}`);
    }
  }

  p.log.message(`Starting policy derivation for workspace ${workspaceId}, deployment ${deploymentId}`);
  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId,
    deploymentId,
    provenance,
  });

  await openReportUiRoute({
    routePath: `/policy/${encodeURIComponent(derived.reviewId)}`,
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    openrouterApiKey,
  });
}
