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

  assert.throws(
    () => parseArgs(['deploy', 'checkpoint', 'HEAD', '--ref']),
    /Missing value for --ref/
  );

  assert.throws(
    () => parseArgs(['deploy', '--env-file', '--no-dry-run', 'checkpoint', 'HEAD']),
    /Missing value for --env-file/
  );
}
