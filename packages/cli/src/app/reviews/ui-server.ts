import * as p from '@clack/prompts';
import { spawn } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createReviewEventsFanout } from './ui-events-fanout.js';
import {
  handleStaticRequest,
  resolveMonorepoDistDir,
  resolveMonorepoReportUiDir,
  resolvePackagedDistDir,
} from './ui-static.js';

const LOCAL_HOST = '127.0.0.1';

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
