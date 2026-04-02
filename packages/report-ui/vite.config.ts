import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'child_process';

const REPORT_UI_MARKER = 'nimbus-report-ui';
const REPORT_UI_HEALTH_PATH = '/__nimbus/report-ui-health';
const STUDIO_CONTEXT_PATH = '/api/studio/context';
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('git@')) {
    const idx = trimmed.indexOf(':');
    if (idx < 0) {
      return null;
    }
    const path = trimmed.slice(idx + 1).replace(/\.git$/i, '');
    return REPO_SLUG_PATTERN.test(path) ? path : null;
  }

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/i, '');
    return REPO_SLUG_PATTERN.test(path) ? path : null;
  } catch {
    return null;
  }
}

function readGitBranch(): string | null {
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return branch || null;
  } catch {
    return null;
  }
}

function readGitRepoSlug(): string | null {
  try {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return parseRepoSlug(origin);
  } catch {
    return null;
  }
}

function reportUiHealthPlugin() {
  return {
    name: 'nimbus-report-ui-health',
    configureServer(server: {
      middlewares: {
        use: (
          handler: (
            req: { url?: string; method?: string },
            res: {
              statusCode: number;
              setHeader: (name: string, value: string) => void;
              end: (body?: string) => void;
            },
            next: () => void
          ) => void
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== REPORT_UI_HEALTH_PATH) {
          next();
          return;
        }

        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Method not allowed');
          return;
        }

        const body = JSON.stringify({
          service: REPORT_UI_MARKER,
          host: '127.0.0.1',
          workerUrl: process.env.NIMBUS_REPORT_UI_HEALTH_WORKER_URL ?? process.env.NIMBUS_API_PROXY_TARGET ?? null,
          authFingerprint: process.env.NIMBUS_REPORT_UI_HEALTH_AUTH_FINGERPRINT ?? null,
        });

        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(body);
      });
    },
  };
}

function studioContextPlugin() {
  return {
    name: 'nimbus-studio-context',
    configureServer(server: {
      middlewares: {
        use: (
          handler: (
            req: { url?: string; method?: string },
            res: {
              statusCode: number;
              setHeader: (name: string, value: string) => void;
              end: (body?: string) => void;
            },
            next: () => void
          ) => void
        ) => void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== STUDIO_CONTEXT_PATH) {
          next();
          return;
        }

        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const body = JSON.stringify({
          repo: readGitRepoSlug(),
          branch: readGitBranch(),
          detectedAt: new Date().toISOString(),
        });

        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(body);
      });
    },
  };
}

function createApiProxy() {
  const apiKey = process.env.NIMBUS_API_KEY?.trim();
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim();
  const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim();

  return {
    target: process.env.NIMBUS_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
    changeOrigin: true,
    configure: (proxy: {
      on: (event: 'proxyReq', listener: (proxyReq: { setHeader: (name: string, value: string) => void }) => void) => void;
    }) => {
      if (!apiKey && !reviewGithubToken && !openrouterApiKey) {
        return;
      }
      proxy.on('proxyReq', (proxyReq) => {
        if (apiKey) {
          proxyReq.setHeader('X-Nimbus-Api-Key', apiKey);
        }
        if (reviewGithubToken) {
          proxyReq.setHeader('X-Review-Github-Token', reviewGithubToken);
        }
        if (openrouterApiKey) {
          proxyReq.setHeader('X-Openrouter-Api-Key', openrouterApiKey);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), reportUiHealthPlugin(), studioContextPlugin()],
  server: {
    host: process.env.VITE_HOST ?? 'localhost',
    port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : undefined,
    strictPort: Boolean(process.env.VITE_PORT),
    proxy: {
      '/api': createApiProxy(),
    },
  },
  preview: {
    proxy: {
      '/api': createApiProxy(),
    },
  },
});
