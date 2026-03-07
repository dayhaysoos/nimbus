import { strict as assert } from 'assert';
import { resolveDeployCheckpointOptions } from './checkpoint-options.js';

type FlagValue = string | boolean | string[];

function flags(input: Record<string, FlagValue>): Record<string, string | boolean | string[]> {
  return input;
}

export function runCheckpointOptionsTests(): void {
  {
    const options = resolveDeployCheckpointOptions(flags({}));
    assert.equal(options.runTestsIfPresent, true);
    assert.equal(options.runLintIfPresent, true);
    assert.equal(options.watch, true);
    assert.equal(options.dryRun, true);
    assert.deepEqual(options.envFiles, []);
    assert.deepEqual(Array.from(options.explicitEnv.entries()), []);
  }

  {
    const options = resolveDeployCheckpointOptions(
      flags({
        'no-tests': true,
        'no-lint': true,
        'no-watch': true,
        ref: 'main',
        'project-root': 'apps/web',
        'env-file': '.env.local,apps/web/.env',
        env: ['API_URL=https://api.example.com', 'SESSION_SECRET=abc123'],
      })
    );

    assert.equal(options.runTestsIfPresent, false);
    assert.equal(options.runLintIfPresent, false);
    assert.equal(options.watch, false);
    assert.equal(options.ref, 'main');
    assert.equal(options.projectRoot, 'apps/web');
    assert.deepEqual(options.envFiles, ['.env.local', 'apps/web/.env']);
    assert.equal(options.explicitEnv.get('API_URL'), 'https://api.example.com');
    assert.equal(options.explicitEnv.get('SESSION_SECRET'), 'abc123');
  }

  {
    const options = resolveDeployCheckpointOptions(
      flags({
        ref: ['main', 'release'],
        'project-root': ['apps/web', 'apps/landing'],
      })
    );

    assert.equal(options.ref, 'release');
    assert.equal(options.projectRoot, 'apps/landing');
  }

  {
    const options = resolveDeployCheckpointOptions(
      flags({
        env: ['CORS_ORIGINS=https://a.com,https://b.com', 'SESSION_SECRET=abc123'],
      })
    );

    assert.equal(options.explicitEnv.get('CORS_ORIGINS'), 'https://a.com,https://b.com');
    assert.equal(options.explicitEnv.get('SESSION_SECRET'), 'abc123');
  }

  assert.throws(
    () => resolveDeployCheckpointOptions(flags({ env: 'INVALID' })),
    /Invalid --env entry "INVALID"/
  );
}
