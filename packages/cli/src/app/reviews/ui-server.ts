import * as p from '@clack/prompts';
import { spawn } from 'child_process';
import { once } from 'events';
import { createReadStream, statSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { dirname, extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { createProxyHeaders, createReviewEventsFanout, type ReviewEventsFanout } from './ui-events-fanout.js';

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

export interface UiServerSession {
  appUrl: string;
  close: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function openBrowser(url: string): void {
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

async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    distDir: string;
    reviewEventsFanout: ReviewEventsFanout;
    workerUrl: string;
    apiKey: string | null;
    reviewGithubToken: string | null;
    openrouterApiKey: string | null;
  }
): Promise<void> {
  try {
    const handledReviewEvents = await options.reviewEventsFanout.handle(request, response);
    if (handledReviewEvents) {
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
  const reviewEventsFanout = createReviewEventsFanout({
    workerUrl: options.workerUrl,
    apiKey: options.apiKey,
    reviewGithubToken: options.reviewGithubToken,
    openrouterApiKey: options.openrouterApiKey,
  });

  const server = createServer((request, response) => {
    void handleStaticRequest(request, response, {
      distDir: options.distDir,
      reviewEventsFanout,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
    });
  });
  server.on('close', () => {
    void reviewEventsFanout.close();
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
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for report UI server at ${url}`);
}

async function startDevServerSession(options: {
  routePath: string;
  reportUiDir: string;
  workerUrl: string;
  port: number;
}): Promise<UiServerSession> {
  const appUrl = `http://${LOCAL_HOST}:${options.port}${options.routePath}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NIMBUS_API_PROXY_TARGET: options.workerUrl,
    VITE_HOST: LOCAL_HOST,
    VITE_PORT: String(options.port),
  };
  delete env.VITE_NIMBUS_API_BASE_URL;

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const serverArgs = ['dev', '--', '--host', LOCAL_HOST, '--port', String(options.port), '--strictPort'];

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
  const appUrl = `http://${LOCAL_HOST}:${options.port}${options.routePath}`;
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

export async function startReportUiSession(options: {
  routePath: string;
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}): Promise<UiServerSession> {
  const bundledDistDir = resolvePackagedDistDir();
  const monorepoDistDir = resolveMonorepoDistDir();
  const distDir = bundledDistDir ?? monorepoDistDir;

  if (distDir) {
    p.log.message(
      `Serving report UI assets from ${distDir} on ${LOCAL_HOST}:${options.port} with API proxy target ${options.workerUrl}`
    );
    return startStaticServerSession({
      routePath: options.routePath,
      distDir,
      workerUrl: options.workerUrl,
      apiKey: options.apiKey,
      reviewGithubToken: options.reviewGithubToken,
      openrouterApiKey: options.openrouterApiKey,
      port: options.port,
    });
  }

  const reportUiDir = resolveMonorepoReportUiDir();
  if (!reportUiDir) {
    throw new Error('Unable to locate bundled report UI assets or monorepo report-ui package. Reinstall or rebuild the CLI package.');
  }

  return startDevServerSession({
    routePath: options.routePath,
    reportUiDir,
    workerUrl: options.workerUrl,
    port: options.port,
  });
}
