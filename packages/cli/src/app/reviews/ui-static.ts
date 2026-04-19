import { createReadStream, statSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, extname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import type { ReviewEventsFanout } from './ui-events-fanout.js';
import { proxyApiRequest } from './ui-proxy.js';

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

export function resolveStaticEntry(distDir: string, rawPathname: string): string | null {
  let pathname = rawPathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }

  const indexPath = join(distDir, 'index.html');
  if (pathname === '/') {
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

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    distDir: string;
    reviewEventsFanout: ReviewEventsFanout;
    workerUrl: string;
    apiKey: string | null;
    reviewGithubToken: string | null;
    providerApiKey: string | null;
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
      options.providerApiKey,
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

export function resolvePackagedDistDir(): string | null {
  const bundled = resolve(MODULE_DIR, '..', '..', '..', 'assets', 'report-ui');
  if (fileExists(join(bundled, 'index.html'))) {
    return bundled;
  }
  return null;
}

export function resolveMonorepoDistDir(): string | null {
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

export function resolveMonorepoReportUiDir(): string | null {
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
