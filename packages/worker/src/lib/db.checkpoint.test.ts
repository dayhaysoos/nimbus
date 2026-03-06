import { strict as assert } from 'assert';
import { createCheckpointJob } from './db.js';

interface PreparedStatementMock {
  bind: (...values: unknown[]) => {
    first<T>(): Promise<T | null>;
  };
}

function createCheckpointDbMock(assertBind: (sql: string, values: unknown[]) => void): D1Database {
  return {
    prepare(sql: string): PreparedStatementMock {
      return {
        bind(...values: unknown[]) {
          assertBind(sql, values);

          return {
            async first<T>() {
              return {
                id: 'job_abc12345',
                prompt: 'Deploy checkpoint 8a513f56ed70',
                model: 'checkpoint',
                status: 'queued',
                phase: 'queued',
                created_at: '2026-03-06T10:00:00.000Z',
                started_at: null,
                completed_at: null,
                cancel_requested_at: null,
                cancelled_at: null,
                preview_url: null,
                deployed_url: null,
                code_url: null,
                code_zip_url: null,
                error_message: null,
                error_code: null,
                file_count: null,
                current_attempt: 0,
                retry_count: 0,
                source_type: 'checkpoint',
                checkpoint_id: '8a513f56ed70',
                commit_sha: 'a'.repeat(40),
                source_ref: 'main',
                source_project_root: 'apps/web',
                build_run_tests_if_present: 1,
                build_run_lint_if_present: 0,
                source_bundle_key: 'jobs/job_abc12345/source/main.tar.gz',
                source_bundle_sha256: 'f'.repeat(64),
                source_bundle_bytes: 1234,
              } as T;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

export async function runCheckpointDbTests(): Promise<void> {
  const db = createCheckpointDbMock((sql, values) => {
    assert.match(sql, /INSERT INTO jobs/i);
    assert.equal(values[0], 'job_abc12345');
    assert.equal(values[2], '8a513f56ed70');
    assert.equal(values[3], 'a'.repeat(40));
    assert.equal(values[4], 'main');
    assert.equal(values[5], 'apps/web');
    assert.equal(values[6], 1);
    assert.equal(values[7], 0);
    assert.equal(values[8], 'jobs/job_abc12345/source/main.tar.gz');
    assert.equal(values[9], 'f'.repeat(64));
    assert.equal(values[10], 1234);
  });

  const created = await createCheckpointJob(db, {
    id: 'job_abc12345',
    prompt: 'Deploy checkpoint 8a513f56ed70',
    checkpointId: '8a513f56ed70',
    commitSha: 'a'.repeat(40),
    sourceRef: 'main',
    sourceProjectRoot: 'apps/web',
    buildRunTestsIfPresent: true,
    buildRunLintIfPresent: false,
    sourceBundleKey: 'jobs/job_abc12345/source/main.tar.gz',
    sourceBundleSha256: 'f'.repeat(64),
    sourceBundleBytes: 1234,
  });

  assert.equal(created.id, 'job_abc12345');
  assert.equal(created.sourceType, 'checkpoint');
  assert.equal(created.checkpointId, '8a513f56ed70');
  assert.equal(created.commitSha, 'a'.repeat(40));
  assert.equal(created.sourceRef, 'main');
  assert.equal(created.sourceProjectRoot, 'apps/web');
  assert.equal(created.buildRunTestsIfPresent, true);
  assert.equal(created.buildRunLintIfPresent, false);
  assert.equal(created.sourceBundleKey, 'jobs/job_abc12345/source/main.tar.gz');
  assert.equal(created.sourceBundleSha256, 'f'.repeat(64));
  assert.equal(created.sourceBundleBytes, 1234);
}
