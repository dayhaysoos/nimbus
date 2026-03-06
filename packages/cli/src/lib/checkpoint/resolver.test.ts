import { strict as assert } from 'assert';
import {
  detectProjectRootCandidates,
  extractEntireSessionId,
  parseCommitTrailers,
  parseDeployInput,
  resolveCheckpointFromHistory,
  selectProjectRoot,
} from './resolver.js';

export function runCheckpointResolverTests(): void {
  {
    const parsed = parseDeployInput('checkpoint:8a513f56ed70');
    assert.deepEqual(parsed, { kind: 'checkpoint', checkpointId: '8a513f56ed70', explicit: true });
  }

  {
    const parsed = parseDeployInput('8a513f56ed70');
    assert.deepEqual(parsed, { kind: 'checkpoint', checkpointId: '8a513f56ed70', explicit: false });
  }

  {
    const parsed = parseDeployInput('commit:main~1');
    assert.deepEqual(parsed, { kind: 'commit', commitish: 'main~1' });
  }

  {
    const parsed = parseDeployInput('v1.2.3');
    assert.deepEqual(parsed, { kind: 'commit', commitish: 'v1.2.3' });
  }

  assert.throws(
    () => parseDeployInput('checkpoint:not-a-hex'),
    /Checkpoint ID must be 12 hexadecimal characters/
  );

  {
    const trailers = parseCommitTrailers(`feat: add thing\n\nBody\n\nEntire-Checkpoint: 8a513f56ed70\nEntire-Attribution: {"sessionId":"sess_123"}`);
    assert.equal(trailers.checkpointId, '8a513f56ed70');
    assert.equal(trailers.entireAttribution, '{"sessionId":"sess_123"}');
    assert.equal(trailers.entireSessionId, 'sess_123');
  }

  {
    const trailers = parseCommitTrailers(
      `fix: adjust\n\nEntire-Attribution: source=entire session_id=sess_456 actor=ai`
    );
    assert.equal(trailers.entireSessionId, 'sess_456');
  }

  {
    const result = resolveCheckpointFromHistory('8a513f56ed70', [
      {
        sha: 'sha_newest',
        message: 'feat\n\nEntire-Checkpoint: 8a513f56ed70',
      },
      {
        sha: 'sha_older',
        message: 'feat\n\nEntire-Checkpoint: 8a513f56ed70',
      },
      {
        sha: 'sha_other',
        message: 'feat\n\nEntire-Checkpoint: ffffffffffff',
      },
    ]);

    assert.equal(result.selected.sha, 'sha_newest');
    assert.equal(result.matchCount, 2);
  }

  assert.throws(
    () =>
      resolveCheckpointFromHistory('8a513f56ed70', [
        {
          sha: 'sha_1',
          message: 'feat\n\nEntire-Checkpoint: ffffffffffff',
        },
      ]),
    /No commit found with trailer Entire-Checkpoint: 8a513f56ed70/
  );

  {
    const root = selectProjectRoot([
      {
        path: '.',
        signals: ['package_json', 'lockfile'],
      },
    ]);
    assert.equal(root.path, '.');
  }

  assert.throws(
    () =>
      selectProjectRoot([
        { path: 'apps/web', signals: ['package_json', 'lockfile'] },
        { path: 'apps/docs', signals: ['package_json', 'framework_config'] },
      ]),
    /Multiple deployable project roots detected/
  );

  {
    const candidates = detectProjectRootCandidates([
      { path: 'apps/web/package.json', content: '{"name":"web"}' },
      { path: 'apps/web/pnpm-lock.yaml' },
      { path: 'apps/docs/package.json', content: '{"name":"docs"}' },
      { path: 'apps/docs/README.md' },
    ]);

    assert.deepEqual(candidates, [
      {
        path: 'apps/web',
        signals: ['lockfile', 'package_json'],
      },
    ]);
  }

  {
    const candidates = detectProjectRootCandidates([
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'root-app',
          scripts: {
            build: 'vite build',
          },
        }),
      },
    ]);

    assert.deepEqual(candidates, [
      {
        path: '.',
        signals: ['build_script', 'package_json'],
      },
    ]);
  }

  assert.equal(extractEntireSessionId(null), null);
}
