import * as p from '@clack/prompts';
import { spawn } from 'child_process';
import type { UiServerSession } from './ui-server.js';

const LOCAL_HOST = '127.0.0.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

export async function startDevServerSession(options: {
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
