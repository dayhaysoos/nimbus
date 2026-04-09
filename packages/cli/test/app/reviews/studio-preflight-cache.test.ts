import { strict as assert } from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getStudioNewReviewPreflightCached,
  resetStudioPreflightCacheForTests,
  setStudioPreflightResolverForTests,
} from '../../../src/app/reviews/studio-preflight-cache.js';
import type { StudioNewReviewPreflightResult } from '../../../src/app/reviews/studio-create.js';

function createPreflightResult(lastCheckpoints: 1 | 2 | 3): StudioNewReviewPreflightResult {
  return {
    repo: 'dayhaysoos/nimbus',
    branch: 'feature/test',
    policyMode: 'auto',
    lastCheckpoints,
    checkpointSelectionMode: lastCheckpoints > 1 ? 'last_n' : 'latest',
    checkpointId: `${lastCheckpoints}`.repeat(12),
    commitSha: `${lastCheckpoints}`.repeat(40),
    includedCheckpoints: [],
    ready: true,
    checks: [
      {
        code: 'checkpoint',
        label: 'Checkpoint target',
        ok: true,
        detail: `Resolved selection ${lastCheckpoints}.`,
      },
      {
        code: 'entire_context',
        label: 'Entire context',
        ok: true,
        detail: 'Readable Entire checkpoint context found for current commit.',
      },
    ],
  };
}

export async function runStudioPreflightCacheTests(): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'nimbus-studio-preflight-cache-'));
  try {
    resetStudioPreflightCacheForTests();
    const pendingByWindow = new Map<1 | 2 | 3, Promise<StudioNewReviewPreflightResult>>();
    const resolveByWindow = new Map<1 | 2 | 3, (value: StudioNewReviewPreflightResult) => void>();
    const calls: Array<1 | 2 | 3> = [];

    setStudioPreflightResolverForTests(async (options) => {
      const normalized = (options?.lastCheckpoints ?? 2) as 1 | 2 | 3;
      calls.push(normalized);
      const existing = pendingByWindow.get(normalized);
      if (existing) {
        return existing;
      }
      const pending = new Promise<StudioNewReviewPreflightResult>((resolve) => {
        resolveByWindow.set(normalized, resolve);
      });
      pendingByWindow.set(normalized, pending);
      return pending;
    });

    const twoPromise = getStudioNewReviewPreflightCached({ repoRoot, lastCheckpoints: 2 });
    const onePromise = getStudioNewReviewPreflightCached({ repoRoot, lastCheckpoints: 1 });

    assert.deepEqual(calls, [2, 1]);

    resolveByWindow.get(2)?.(createPreflightResult(2));
    resolveByWindow.get(1)?.(createPreflightResult(1));

    const [twoResult, oneResult] = await Promise.all([twoPromise, onePromise]);
    assert.equal(twoResult.lastCheckpoints, 2);
    assert.equal(oneResult.lastCheckpoints, 1);
    assert.equal(twoResult.checkpointId, '222222222222');
    assert.equal(oneResult.checkpointId, '111111111111');
  } finally {
    setStudioPreflightResolverForTests(null);
    resetStudioPreflightCacheForTests();
    await rm(repoRoot, { recursive: true, force: true });
  }
}
