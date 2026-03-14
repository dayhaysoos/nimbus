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
      '--tests',
      '--build',
      '--idempotency-key',
      'deploy-1',
      '--provider',
      'cloudflare_workers_assets',
      '--output-dir',
      'dist',
      '--summarize-session',
      'always',
      '--intent-token-budget',
      '1800',
      '--poll-interval-ms',
      '2000',
      'deploy',
      'ws_abc12345',
    ]);
    assert.equal(parsed.flags['idempotency-key'], 'deploy-1');
    assert.equal(parsed.flags.tests, true);
    assert.equal(parsed.flags.build, true);
    assert.equal(parsed.flags.provider, 'cloudflare_workers_assets');
    assert.equal(parsed.flags['output-dir'], 'dist');
    assert.equal(parsed.flags['summarize-session'], 'always');
    assert.equal(parsed.flags['intent-token-budget'], '1800');
    assert.equal(parsed.flags['poll-interval-ms'], '2000');
  }

  {
    const parsed = parseArgs([
      'review',
      '--commit',
      'main~1',
      '--workspace',
      'ws_abc12345',
      '--deployment',
      'dep_abcd1234',
      '--severity-threshold',
      'medium',
      '--max-findings',
      '12',
      '--model',
      'sonnet-4.5',
      '--no-provenance',
      '--no-validation-evidence',
      '--format',
      'markdown',
      '--out',
      'review.md',
      'export',
      'rev_abcd1234',
    ]);
    assert.equal(parsed.flags.workspace, 'ws_abc12345');
    assert.equal(parsed.flags.commit, 'main~1');
    assert.equal(parsed.flags.deployment, 'dep_abcd1234');
    assert.equal(parsed.flags['severity-threshold'], 'medium');
    assert.equal(parsed.flags['max-findings'], '12');
    assert.equal(parsed.flags.model, 'sonnet-4.5');
    assert.equal(parsed.flags['no-provenance'], true);
    assert.equal(parsed.flags['no-validation-evidence'], true);
    assert.equal(parsed.flags.format, 'markdown');
    assert.equal(parsed.flags.out, 'review.md');
  }

  {
    const parsed = parseArgs(['review', 'create', '--commit']);
    assert.equal(parsed.flags.commit, true);
    assert.deepEqual(parsed.positional, ['create']);
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
