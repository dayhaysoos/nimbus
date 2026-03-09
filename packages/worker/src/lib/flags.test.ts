import { strict as assert } from 'assert';
import type { Env } from '../types.js';
import {
  DEFAULT_RUNTIME_FLAGS,
  getRuntimeFlagsFromEnv,
  loadRuntimeFlags,
  mergeRuntimeFlagOverrides,
  type RuntimeFlagRow,
} from './flags.js';

function createDb(rows: RuntimeFlagRow[] = [], errorMessage?: string): D1Database {
  return {
    prepare() {
      return {
        async all<T>() {
          if (errorMessage) {
            throw new Error(errorMessage);
          }

          return {
            results: rows as unknown as T[],
            success: true,
            meta: {
              duration: 0,
              rows_read: rows.length,
              rows_written: 0,
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    Sandbox: {} as DurableObjectNamespace<any>,
    DB: createDb(),
    ...overrides,
  };
}

export async function runFlagsTests(): Promise<void> {
  {
    const env = createEnv();
    const resolved = getRuntimeFlagsFromEnv(env);
    assert.deepEqual(resolved, DEFAULT_RUNTIME_FLAGS);
  }

  {
    const env = createEnv({
      V2_ENABLED: 'true',
      MAX_ATTEMPTS: '0',
      ATTEMPT_TIMEOUT_MS: '45000',
      TOTAL_TIMEOUT_MS: '120000',
      LINT_BLOCKING: '1',
      TEST_BLOCKING: 'off',
      RAW_RETENTION_DAYS: '2',
      SUMMARY_RETENTION_DAYS: '8',
    });

    const resolved = getRuntimeFlagsFromEnv(env);

    assert.equal(resolved.v2Enabled, true);
    assert.equal(resolved.maxAttempts, 1);
    assert.equal(resolved.attemptTimeoutMs, 60000);
    assert.equal(resolved.totalTimeoutMs, 120000);
    assert.equal(resolved.lintBlocking, true);
    assert.equal(resolved.testBlocking, false);
    assert.equal(resolved.rawRetentionDays, 2);
    assert.equal(resolved.summaryRetentionDays, 8);
  }

  {
    const env = createEnv({
      ATTEMPT_TIMEOUT_MS: '900000',
      TOTAL_TIMEOUT_MS: '120000',
    });

    const resolved = getRuntimeFlagsFromEnv(env);
    assert.equal(resolved.attemptTimeoutMs, 900000);
    assert.equal(resolved.totalTimeoutMs, 900000);
  }

  {
    const base = DEFAULT_RUNTIME_FLAGS;
    const merged = mergeRuntimeFlagOverrides(base, [
      { key: 'max_attempts', value: '5' },
      { key: 'v2_enabled', value: 'true' },
      { key: 'workspace_deploy_enabled', value: 'true' },
      { key: 'unknown_key', value: 'ignored' },
    ]);

    assert.equal(merged.maxAttempts, 5);
    assert.equal(merged.v2Enabled, true);
    assert.equal(merged.workspaceDeployEnabled, true);
    assert.equal(merged.rawRetentionDays, DEFAULT_RUNTIME_FLAGS.rawRetentionDays);
  }

  {
    const env = createEnv({
      V2_ENABLED: 'false',
      MAX_ATTEMPTS: '3',
      DB: createDb([
        { key: 'v2_enabled', value: 'true' },
        { key: 'max_attempts', value: '4' },
      ]),
    });

    const resolved = await loadRuntimeFlags(env);

    assert.equal(resolved.v2Enabled, true);
    assert.equal(resolved.maxAttempts, 4);
  }

  {
    const env = createEnv({
      V2_ENABLED: 'true',
      DB: createDb([], 'no such table: runtime_flags'),
    });

    const resolved = await loadRuntimeFlags(env);
    assert.equal(resolved.v2Enabled, true);
    assert.equal(resolved.maxAttempts, DEFAULT_RUNTIME_FLAGS.maxAttempts);
  }
}
