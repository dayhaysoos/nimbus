import { execFileSync } from 'child_process';
import { readFileSync, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { resolveStudioNewReviewPreflight, type StudioNewReviewPreflightResult } from './studio-create.js';

interface PreflightCacheState {
  headSha: string | null;
  policyMode: 'auto' | 'review' | null;
  lastCheckpoints: 1 | 2 | 3 | null;
  refreshedAtMs: number | null;
  value: StudioNewReviewPreflightResult | null;
}

const PREFLIGHT_CACHE_MAX_AGE_MS = 8_000;

let cache: PreflightCacheState = {
  headSha: null,
  policyMode: null,
  lastCheckpoints: null,
  refreshedAtMs: null,
  value: null,
};
const inFlightByKey = new Map<string, Promise<StudioNewReviewPreflightResult>>();
let headWatcher: FSWatcher | null = null;
let refWatcher: FSWatcher | null = null;
let studioPreferencesWatcher: FSWatcher | null = null;
let refreshDebounceTimer: NodeJS.Timeout | null = null;
let resolveStudioNewReviewPreflightForCache: typeof resolveStudioNewReviewPreflight = resolveStudioNewReviewPreflight;

function resolveHeadSha(repoRoot: string): string | null {
  try {
    return new GitRepo(repoRoot).resolveCommitSha('HEAD');
  } catch {
    return null;
  }
}

function resolveStudioPolicyMode(repoRoot: string): 'auto' | 'review' | null {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, '.nimbus', 'studio.json'), 'utf8')) as {
      policyMode?: unknown;
    };
    if (raw.policyMode === 'auto' || raw.policyMode === 'review') {
      return raw.policyMode;
    }
    return null;
  } catch {
    return null;
  }
}

async function refreshPreflight(repoRoot: string, lastCheckpoints: 1 | 2 | 3): Promise<StudioNewReviewPreflightResult> {
  const inFlightKey = `${repoRoot}:${lastCheckpoints}`;
  const existing = inFlightByKey.get(inFlightKey);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    const result = await resolveStudioNewReviewPreflightForCache({ repoRoot, lastCheckpoints });
    cache = {
      headSha: resolveHeadSha(repoRoot),
      policyMode: resolveStudioPolicyMode(repoRoot),
      lastCheckpoints,
      refreshedAtMs: Date.now(),
      value: result,
    };
    return result;
  })();
  inFlightByKey.set(inFlightKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightByKey.get(inFlightKey) === pending) {
      inFlightByKey.delete(inFlightKey);
    }
  }
}

function resolveGitDir(repoRoot: string): string | null {
  try {
    const output = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!output) {
      return null;
    }
    return output.startsWith('/') ? output : join(repoRoot, output);
  } catch {
    return null;
  }
}

function resolveHeadRef(gitDir: string): string | null {
  try {
    const output = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!output.startsWith('ref:')) {
      return null;
    }
    const headRef = output.slice(4).trim();
    return headRef || null;
  } catch {
    return null;
  }
}

function queueRefresh(repoRoot: string): void {
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
  }
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    void refreshPreflight(repoRoot, 1).catch(() => undefined);
  }, 250);
  if (typeof refreshDebounceTimer.unref === 'function') {
    refreshDebounceTimer.unref();
  }
}

function closeWatchers(): void {
  if (headWatcher) {
    headWatcher.close();
    headWatcher = null;
  }
  if (refWatcher) {
    refWatcher.close();
    refWatcher = null;
  }
  if (studioPreferencesWatcher) {
    studioPreferencesWatcher.close();
    studioPreferencesWatcher = null;
  }
}

function watchHeadRefPath(repoRoot: string, gitDir: string): void {
  if (refWatcher) {
    refWatcher.close();
    refWatcher = null;
  }
  const headRef = resolveHeadRef(gitDir);
  if (!headRef || !headRef.startsWith('refs/')) {
    return;
  }
  const headRefPath = join(gitDir, ...headRef.split('/'));
  try {
    refWatcher = watch(headRefPath, () => {
      queueRefresh(repoRoot);
    });
  } catch {
    refWatcher = null;
  }
}

export async function getStudioNewReviewPreflightCached(options?: {
  repoRoot?: string;
  lastCheckpoints?: 1 | 2 | 3;
}): Promise<StudioNewReviewPreflightResult> {
  const repoRoot = options?.repoRoot ?? process.cwd();
  const lastCheckpoints = options?.lastCheckpoints ?? 1;
  const headSha = resolveHeadSha(repoRoot);
  const policyMode = resolveStudioPolicyMode(repoRoot);
  const cacheIsFresh =
    typeof cache.refreshedAtMs === 'number' && Date.now() - cache.refreshedAtMs <= PREFLIGHT_CACHE_MAX_AGE_MS;
  if (
    cache.value &&
    cacheIsFresh &&
    cache.headSha &&
    headSha &&
    cache.headSha === headSha &&
    cache.policyMode === policyMode &&
    cache.lastCheckpoints === lastCheckpoints
  ) {
    return cache.value;
  }
  return refreshPreflight(repoRoot, lastCheckpoints);
}

export function startStudioPreflightBackgroundPolling(options?: {
  repoRoot?: string;
}): void {
  if (headWatcher) {
    return;
  }
  const repoRoot = options?.repoRoot ?? process.cwd();
  const gitDir = resolveGitDir(repoRoot);

  void refreshPreflight(repoRoot, 1).catch(() => undefined);
  if (!gitDir) {
    return;
  }

  const headPath = join(gitDir, 'HEAD');
  try {
    headWatcher = watch(headPath, () => {
      watchHeadRefPath(repoRoot, gitDir);
      queueRefresh(repoRoot);
    });
  } catch {
    headWatcher = null;
    return;
  }
  watchHeadRefPath(repoRoot, gitDir);
  const studioPreferencesPath = join(repoRoot, '.nimbus', 'studio.json');
  try {
    studioPreferencesWatcher = watch(studioPreferencesPath, () => {
      queueRefresh(repoRoot);
    });
  } catch {
    studioPreferencesWatcher = null;
  }
}

export function stopStudioPreflightBackgroundPolling(): void {
  closeWatchers();
  if (refreshDebounceTimer) {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = null;
  }
}

export function setStudioPreflightResolverForTests(
  resolver: typeof resolveStudioNewReviewPreflight | null
): void {
  resolveStudioNewReviewPreflightForCache = resolver ?? resolveStudioNewReviewPreflight;
}

export function resetStudioPreflightCacheForTests(): void {
  stopStudioPreflightBackgroundPolling();
  cache = {
    headSha: null,
    policyMode: null,
    lastCheckpoints: null,
    refreshedAtMs: null,
    value: null,
  };
  inFlightByKey.clear();
  resolveStudioNewReviewPreflightForCache = resolveStudioNewReviewPreflight;
}
