import * as p from '@clack/prompts';
import { spawn } from 'child_process';
import {
  resolveMonorepoDistDir,
  resolveMonorepoReportUiDir,
  resolvePackagedDistDir,
} from './ui-static.js';
import { startDevServerSession } from './ui-dev-server.js';
import { startStaticServerSession } from './ui-static-server.js';

const LOCAL_HOST = '127.0.0.1';

export interface UiServerSession {
  appUrl: string;
  uiMode: 'static' | 'dev';
  close: () => Promise<void>;
  waitForExit: () => Promise<void>;
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

export async function startReportUiSession(options: {
  routePath: string;
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
  preferDevServer?: boolean;
  repoRoot?: string;
}): Promise<UiServerSession> {
  if (options.preferDevServer) {
    const reportUiDir = resolveMonorepoReportUiDir();
    if (!reportUiDir) {
      throw new Error('Unable to locate monorepo report-ui package for --dev-ui mode.');
    }
    return startDevServerSession({
      routePath: options.routePath,
      reportUiDir,
      repoRoot: options.repoRoot,
      workerUrl: options.workerUrl,
      port: options.port,
    });
  }

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
    repoRoot: options.repoRoot,
    workerUrl: options.workerUrl,
    port: options.port,
  });
}
