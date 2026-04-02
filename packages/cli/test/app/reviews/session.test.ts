import { strict as assert } from 'assert';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureStudioPreferencesForTests,
  getReviewStudioRuntimeStatus,
  readStudioPreferencesForTests,
  resolveReviewUiRuntimeContext,
  stopReviewStudioRuntime,
} from '../../../src/app/reviews/session.js';

export async function runReviewUiSessionTests(): Promise<void> {
  const originalNimbusApiKey = process.env.NIMBUS_API_KEY;
  const originalReviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN;
  const originalOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;

  try {
    process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

    {
      const warnings: string[] = [];
      delete process.env.NIMBUS_API_KEY;
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = 'ghs_test';
      process.env.OPENROUTER_API_KEY = 'or_test';

      const runtime = resolveReviewUiRuntimeContext({
        reporter: {
          warning: (message) => warnings.push(message),
        },
      });

      assert.equal(runtime.port, 2000);
      assert.equal(runtime.workerUrl, 'https://worker.example.com');
      assert.equal(runtime.apiKey, null);
      assert.equal(runtime.reviewGithubToken, 'ghs_test');
      assert.equal(runtime.openrouterApiKey, 'or_test');
      assert.equal(warnings.length, 1);
    }

    {
      process.env.NIMBUS_API_KEY = 'nmb_live_test';
      const runtime = resolveReviewUiRuntimeContext({ port: 4321 });
      assert.equal(runtime.port, 4321);
      assert.equal(runtime.apiKey, 'nmb_live_test');
    }

    assert.throws(() => resolveReviewUiRuntimeContext({ port: 0 }), /Invalid port/);
    assert.throws(() => resolveReviewUiRuntimeContext({ port: 70000 }), /Invalid port/);

    {
      const tempRepo = await mkdtemp(join(tmpdir(), 'nimbus-studio-pref-'));
      try {
        await ensureStudioPreferencesForTests(tempRepo);
        const prefs = await readStudioPreferencesForTests(tempRepo);
        assert.deepEqual(prefs, { schemaVersion: 1, policyMode: 'auto' });
      } finally {
        await rm(tempRepo, { recursive: true, force: true });
      }
    }

    {
      const tempRepo = await mkdtemp(join(tmpdir(), 'nimbus-studio-runtime-'));
      const runtimeDir = join(tempRepo, '.nimbus', 'studio');
      const testPort = 43217;
      try {
        await mkdir(runtimeDir, { recursive: true });
        await writeFile(
          join(runtimeDir, 'runtime.json'),
          `${JSON.stringify({
            schemaVersion: 1,
            pid: 424242,
            port: testPort,
            workerUrl: 'https://worker.example.com',
            repoRoot: tempRepo,
            startedAt: '2026-01-01T00:00:00.000Z',
            replayCursors: {},
          })}\n`,
          'utf8'
        );

        const originalFetch = globalThis.fetch;
        const originalKill = process.kill;
        let terminated = false;
        try {
          globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
          (process as unknown as { kill: typeof process.kill }).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            assert.equal(pid, 424242);
            if (signal === 'SIGTERM') {
              terminated = true;
              return true;
            }
            if (signal === 0 && terminated) {
              throw new Error('ESRCH');
            }
            return true;
          }) as typeof process.kill;

          const runtime = resolveReviewUiRuntimeContext({ port: testPort });
          const status = await getReviewStudioRuntimeStatus(runtime, { repoRoot: tempRepo });
          assert.equal(status.running, true);
          assert.equal(status.stale, false);

          const stop = await stopReviewStudioRuntime(runtime, { repoRoot: tempRepo });
          assert.equal(stop.stopped, true);
          assert.equal(stop.stale, false);

          const after = await getReviewStudioRuntimeStatus(runtime, { repoRoot: tempRepo });
          assert.equal(after.running, false);
          assert.equal(after.runtime, null);
        } finally {
          globalThis.fetch = originalFetch;
          (process as unknown as { kill: typeof process.kill }).kill = originalKill;
        }
      } finally {
        await rm(tempRepo, { recursive: true, force: true });
      }
    }
  } finally {
    if (originalNimbusApiKey === undefined) {
      delete process.env.NIMBUS_API_KEY;
    } else {
      process.env.NIMBUS_API_KEY = originalNimbusApiKey;
    }
    if (originalReviewGithubToken === undefined) {
      delete process.env.REVIEW_CONTEXT_GITHUB_TOKEN;
    } else {
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = originalReviewGithubToken;
    }
    if (originalOpenrouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenrouterApiKey;
    }
    if (originalWorkerUrl === undefined) {
      delete process.env.NIMBUS_WORKER_URL;
    } else {
      process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
    }
  }
}
