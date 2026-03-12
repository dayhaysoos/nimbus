import { strict as assert } from 'assert';
import { parseArgs } from './args.js';

export function runArgsParsingTests(): void {
  {
    const parsed = parseArgs(['deploy', '--no-dry-run', 'checkpoint', 'main~1']);
    assert.equal(parsed.command, 'deploy');
    assert.equal(parsed.flags['no-dry-run'], true);
    assert.deepEqual(parsed.positional, ['checkpoint', 'main~1']);
  }

  {
    const parsed = parseArgs(['deploy', '--ref', 'main', '--env', 'A=1', '--env', 'B=2', 'checkpoint', 'HEAD']);
    assert.equal(parsed.command, 'deploy');
    assert.equal(parsed.flags.ref, 'main');
    assert.deepEqual(parsed.flags.env, ['A=1', 'B=2']);
    assert.deepEqual(parsed.positional, ['checkpoint', 'HEAD']);
  }

  {
    const parsed = parseArgs([
      'workspace',
      '--idempotency-key',
      'deploy-1',
      '--provider',
      'cloudflare_workers_assets',
      '--output-dir',
      'dist',
      '--poll-interval-ms',
      '2000',
      'deploy',
      'ws_abc12345',
    ]);
    assert.equal(parsed.flags['idempotency-key'], 'deploy-1');
    assert.equal(parsed.flags.provider, 'cloudflare_workers_assets');
    assert.equal(parsed.flags['output-dir'], 'dist');
    assert.equal(parsed.flags['poll-interval-ms'], '2000');
  }

  {
    const parsed = parseArgs([
      'review',
      '--workspace',
      'ws_abc12345',
      '--deployment',
      'dep_abcd1234',
      '--format',
      'markdown',
      '--out',
      'review.md',
      'export',
      'rev_abcd1234',
    ]);
    assert.equal(parsed.flags.workspace, 'ws_abc12345');
    assert.equal(parsed.flags.deployment, 'dep_abcd1234');
    assert.equal(parsed.flags.format, 'markdown');
    assert.equal(parsed.flags.out, 'review.md');
  }

  assert.throws(
    () => parseArgs(['deploy', 'checkpoint', 'HEAD', '--ref']),
    /Missing value for --ref/
  );

  assert.throws(
    () => parseArgs(['deploy', '--env-file', '--no-dry-run', 'checkpoint', 'HEAD']),
    /Missing value for --env-file/
  );
}
