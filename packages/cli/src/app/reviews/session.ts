import * as p from '@clack/prompts';
import { execFileSync } from 'child_process';
import { spawn } from 'child_process';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { getWorkerUrl, readOpenrouterApiKey, readProviderApiKey } from '../../clients/worker/shared.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { startStudioPreflightBackgroundPolling, stopStudioPreflightBackgroundPolling } from './studio-preflight-cache.js';
import { startReportUiSession } from './ui-server.js';

export const DEFAULT_OPEN_PORT = 2000;
export const LOCAL_HOST = '127.0.0.1';
const STUDIO_SCHEMA_VERSION = 1;
const STUDIO_READY_TIMEOUT_MS = 20_000;

type ReviewUiReporter = {
  warning: (message: string) => void;
};

const defaultReporter: ReviewUiReporter = {
  warning: (message) => p.log.warning(message),
};

export interface ReviewUiRuntimeContext {
  port: number;
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  providerApiKey: string | null;
  openrouterApiKey: string | null;
  preferDevUi: boolean;
}

export interface StudioRuntimeMetadata {
  schemaVersion: 1;
  pid: number;
  port: number;
  workerUrl: string;
  repoRoot: string;
  startedAt: string;
  replayCursors: Record<string, number>;
  uiMode?: 'static' | 'dev';
}

export interface StudioPreferences {
  schemaVersion: 1;
  policyMode: 'auto' | 'review';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function resolveRepoRoot(): string {
  return new GitRepo(process.cwd()).getRepoRoot();
}

function resolveStudioPaths(repoRoot: string): {
  rootDir: string;
  runtimeDir: string;
  runtimePath: string;
  preferencesPath: string;
} {
  const rootDir = join(repoRoot, '.nimbus');
  const runtimeDir = join(rootDir, 'studio');
  return {
    rootDir,
    runtimeDir,
    runtimePath: join(runtimeDir, 'runtime.json'),
    preferencesPath: join(rootDir, 'studio.json'),
  };
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureStudioPreferenceFile(repoRoot: string): Promise<void> {
  const paths = resolveStudioPaths(repoRoot);
  await mkdir(paths.rootDir, { recursive: true });
  const existing = await readJsonFile<StudioPreferences>(paths.preferencesPath);
  if (existing?.schemaVersion === STUDIO_SCHEMA_VERSION && (existing.policyMode === 'auto' || existing.policyMode === 'review')) {
    return;
  }
  const initial: StudioPreferences = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    policyMode: 'auto',
  };
  await writeJsonFile(paths.preferencesPath, initial);
}

function isValidStudioPolicyMode(value: unknown): value is StudioPreferences['policyMode'] {
  return value === 'auto' || value === 'review';
}

async function readRuntimeMetadata(repoRoot: string): Promise<StudioRuntimeMetadata | null> {
  const paths = resolveStudioPaths(repoRoot);
  const parsed = await readJsonFile<StudioRuntimeMetadata>(paths.runtimePath);
  if (!parsed || parsed.schemaVersion !== STUDIO_SCHEMA_VERSION) {
    return null;
  }
  if (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535) {
    return null;
  }
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return null;
  }
  return parsed;
}

async function writeRuntimeMetadata(repoRoot: string, metadata: StudioRuntimeMetadata): Promise<void> {
  const paths = resolveStudioPaths(repoRoot);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeJsonFile(paths.runtimePath, metadata);
}

async function clearRuntimeMetadataIfOwned(repoRoot: string, pid: number): Promise<void> {
  const paths = resolveStudioPaths(repoRoot);
  const current = await readRuntimeMetadata(repoRoot);
  if (current?.pid !== pid) {
    return;
  }
  await rm(paths.runtimePath, { force: true }).catch(() => undefined);
}

async function clearRuntimeMetadata(repoRoot: string): Promise<void> {
  const paths = resolveStudioPaths(repoRoot);
  await rm(paths.runtimePath, { force: true }).catch(() => undefined);
}

async function isStudioRuntimeHealthy(metadata: StudioRuntimeMetadata): Promise<boolean> {
  try {
    process.kill(metadata.pid, 0);
  } catch {
    return false;
  }
  try {
    const response = await fetch(`http://${LOCAL_HOST}:${metadata.port}/`, { method: 'GET' });
    return response.status < 500;
  } catch {
    return false;
  }
}

function resolveListeningPidByPort(port: number): number | null {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!output) {
      return null;
    }
    const firstLine = output.split(/\r?\n/)[0]?.trim();
    const pid = Number.parseInt(firstLine ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function buildDetachedStudioSpawnArgs(port: number, preferDevUi: boolean): string[] {
  if (!process.argv[1]) {
    throw new Error('Unable to resolve current CLI entrypoint for detached Studio launch.');
  }
  const args = [...process.execArgv, process.argv[1], 'review', 'studio', '--serve', '--port', String(port)];
  if (preferDevUi) {
    args.push('--dev-ui');
  }
  return args;
}

function launchDetachedStudioProcess(repoRoot: string, port: number, preferDevUi: boolean): number {
  const child = spawn(process.execPath, buildDetachedStudioSpawnArgs(port, preferDevUi), {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (!child.pid) {
    throw new Error('Detached Studio launch did not return a process id.');
  }
  return child.pid;
}

async function waitForStudioReadiness(port: number, timeoutMs = STUDIO_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${LOCAL_HOST}:${port}/`, { method: 'GET' });
      if (response.status < 500) {
        return;
      }
    } catch {
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Studio runtime on ${LOCAL_HOST}:${port}.`);
}

export function resolveReviewUiRuntimeContext(
  options?: {
    port?: number;
    preferDevUi?: boolean;
    reporter?: ReviewUiReporter;
  }
): ReviewUiRuntimeContext {
  const reporter = options?.reporter ?? defaultReporter;
  const port = options?.port ?? DEFAULT_OPEN_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port. Use an integer between 1 and 65535.');
  }

  const workerUrl = getWorkerUrl();
  const apiKey = process.env.NIMBUS_API_KEY?.trim() ?? null;
  const reviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN?.trim() ?? null;
  const providerApiKey = readProviderApiKey();
  const openrouterApiKey = readOpenrouterApiKey();
  if (!apiKey) {
    reporter.warning('NIMBUS_API_KEY is not set. Hosted worker requests may be rejected as unauthenticated.');
  }

  return {
    port,
    workerUrl,
    apiKey,
    reviewGithubToken,
    providerApiKey,
    openrouterApiKey,
    preferDevUi: Boolean(options?.preferDevUi),
  };
}

export async function ensureReviewStudioRuntime(
  runtime: ReviewUiRuntimeContext,
  options?: { routePath?: string }
): Promise<{ appUrl: string; reused: boolean }> {
  const repoRoot = resolveRepoRoot();
  const routePath = options?.routePath ?? '/';
  await ensureStudioPreferenceFile(repoRoot);

  const existing = await readRuntimeMetadata(repoRoot);
  if (existing && existing.port === runtime.port && (await isStudioRuntimeHealthy(existing))) {
    const existingIsDev = existing.uiMode === 'dev';
    if (runtime.preferDevUi && !existingIsDev) {
      try {
        process.kill(existing.pid, 'SIGTERM');
        await waitForProcessExit(existing.pid);
      } catch {
      }
      await clearRuntimeMetadata(repoRoot);
    } else {
      return {
        appUrl: `http://${LOCAL_HOST}:${runtime.port}${routePath}`,
        reused: true,
      };
    }
  }

  const pid = launchDetachedStudioProcess(repoRoot, runtime.port, runtime.preferDevUi);
  await writeRuntimeMetadata(repoRoot, {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    pid,
    port: runtime.port,
    workerUrl: runtime.workerUrl,
    repoRoot,
    startedAt: new Date().toISOString(),
    replayCursors: {},
  });
  try {
    await waitForStudioReadiness(runtime.port);
  } catch (error) {
    await clearRuntimeMetadataIfOwned(repoRoot, pid);
    throw error;
  }
  return {
    appUrl: `http://${LOCAL_HOST}:${runtime.port}${routePath}`,
    reused: false,
  };
}

export async function runStudioServeProcess(runtime: ReviewUiRuntimeContext): Promise<void> {
  const repoRoot = resolveRepoRoot();
  await ensureStudioPreferenceFile(repoRoot);
  startStudioPreflightBackgroundPolling({ repoRoot });
  let uiSession: Awaited<ReturnType<typeof startReportUiSession>> | null = null;
  try {
    uiSession = await startReportUiSession({
      routePath: '/',
      port: runtime.port,
      workerUrl: runtime.workerUrl,
      apiKey: runtime.apiKey,
      reviewGithubToken: runtime.reviewGithubToken,
      providerApiKey: runtime.providerApiKey,
      openrouterApiKey: runtime.openrouterApiKey,
      preferDevServer: runtime.preferDevUi,
      repoRoot,
    });

    await writeRuntimeMetadata(repoRoot, {
      schemaVersion: STUDIO_SCHEMA_VERSION,
      pid: process.pid,
      port: runtime.port,
      workerUrl: runtime.workerUrl,
      repoRoot,
      startedAt: new Date().toISOString(),
      replayCursors: {},
      uiMode: uiSession.uiMode,
    });
  } catch (error) {
    stopStudioPreflightBackgroundPolling();
    if (uiSession) {
      await uiSession.close().catch(() => undefined);
    }
    throw error;
  }
  const activeSession = uiSession;
  if (!activeSession) {
    stopStudioPreflightBackgroundPolling();
    throw new Error('Studio UI session did not initialize.');
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopStudioPreflightBackgroundPolling();
    await activeSession.close().catch(() => undefined);
    await clearRuntimeMetadataIfOwned(repoRoot, process.pid);
  };
  const handleSignal = () => {
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  try {
    await activeSession.waitForExit();
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await shutdown();
  }
}

export async function getReviewStudioRuntimeStatus(
  runtime: ReviewUiRuntimeContext,
  options?: { repoRoot?: string }
): Promise<{
  running: boolean;
  stale: boolean;
  appUrl: string;
  runtime: StudioRuntimeMetadata | null;
}> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const runtimeMetadata = await readRuntimeMetadata(repoRoot);
  if (!runtimeMetadata) {
    const untrackedPid = resolveListeningPidByPort(runtime.port);
    if (untrackedPid) {
      return {
        running: true,
        stale: true,
        appUrl: `http://${LOCAL_HOST}:${runtime.port}/`,
        runtime: null,
      };
    }
    return {
      appUrl: `http://${LOCAL_HOST}:${runtime.port}/`,
      running: false,
      stale: false,
      runtime: null,
    };
  }
  const healthy = runtimeMetadata.port === runtime.port && (await isStudioRuntimeHealthy(runtimeMetadata));
  return {
    running: healthy,
    stale: !healthy,
    appUrl: `http://${LOCAL_HOST}:${runtime.port}/`,
    runtime: runtimeMetadata,
  };
}

export async function stopReviewStudioRuntime(
  runtime: ReviewUiRuntimeContext,
  options?: { repoRoot?: string }
): Promise<{ stopped: boolean; stale: boolean }> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const runtimeMetadata = await readRuntimeMetadata(repoRoot);
  if (!runtimeMetadata) {
    const untrackedPid = resolveListeningPidByPort(runtime.port);
    if (!untrackedPid) {
      return { stopped: false, stale: false };
    }
    try {
      process.kill(untrackedPid, 'SIGTERM');
      const stoppedByPort = await waitForProcessExit(untrackedPid);
      return { stopped: stoppedByPort, stale: !stoppedByPort };
    } catch {
      return { stopped: false, stale: true };
    }
  }

  if (runtimeMetadata.port !== runtime.port) {
    return { stopped: false, stale: false };
  }

  const metadataPid = runtimeMetadata.pid;
  let stale = false;
  let stopped = false;
  try {
    process.kill(metadataPid, 'SIGTERM');
    stopped = await waitForProcessExit(metadataPid);
  } catch {
    stale = true;
    stopped = false;
  } finally {
    await clearRuntimeMetadata(repoRoot);
  }
  if (stopped) {
    return { stopped: true, stale: false };
  }

  const fallbackPid = resolveListeningPidByPort(runtime.port);
  if (fallbackPid && fallbackPid !== metadataPid) {
    try {
      process.kill(fallbackPid, 'SIGTERM');
      const stoppedByPort = await waitForProcessExit(fallbackPid);
      return { stopped: stoppedByPort, stale: !stoppedByPort || stale };
    } catch {
      return { stopped: false, stale: true };
    }
  }
  return { stopped, stale };
}

export async function clearStaleReviewStudioRuntimeMetadata(
  runtime: ReviewUiRuntimeContext,
  options?: { repoRoot?: string }
): Promise<boolean> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  const runtimeMetadata = await readRuntimeMetadata(repoRoot);
  if (!runtimeMetadata) {
    return false;
  }
  if (runtimeMetadata.port !== runtime.port) {
    return false;
  }
  if (await isStudioRuntimeHealthy(runtimeMetadata)) {
    return false;
  }
  await clearRuntimeMetadata(repoRoot);
  return true;
}

export async function readStudioPreferencesForTests(repoRoot: string): Promise<StudioPreferences | null> {
  return readJsonFile<StudioPreferences>(resolveStudioPaths(repoRoot).preferencesPath);
}

export async function readStudioPreferences(options?: { repoRoot?: string }): Promise<StudioPreferences> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  await ensureStudioPreferenceFile(repoRoot);
  const existing = await readJsonFile<StudioPreferences>(resolveStudioPaths(repoRoot).preferencesPath);
  if (existing?.schemaVersion === STUDIO_SCHEMA_VERSION && isValidStudioPolicyMode(existing.policyMode)) {
    return existing;
  }
  const fallback: StudioPreferences = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    policyMode: 'auto',
  };
  await writeJsonFile(resolveStudioPaths(repoRoot).preferencesPath, fallback);
  return fallback;
}

export async function updateStudioPolicyMode(
  policyMode: StudioPreferences['policyMode'],
  options?: { repoRoot?: string }
): Promise<StudioPreferences> {
  if (!isValidStudioPolicyMode(policyMode)) {
    throw new Error('Invalid Studio policy mode. Use auto or review.');
  }
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();
  await ensureStudioPreferenceFile(repoRoot);
  const next: StudioPreferences = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    policyMode,
  };
  await writeJsonFile(resolveStudioPaths(repoRoot).preferencesPath, next);
  return next;
}

export async function readStudioRuntimeForTests(repoRoot: string): Promise<StudioRuntimeMetadata | null> {
  return readRuntimeMetadata(repoRoot);
}

export async function ensureStudioPreferencesForTests(repoRoot: string): Promise<void> {
  await ensureStudioPreferenceFile(repoRoot);
}
