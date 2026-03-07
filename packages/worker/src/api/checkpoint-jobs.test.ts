import { strict as assert } from 'assert';
import {
  MAX_SOURCE_BUNDLE_BYTES,
  handleCreateCheckpointJob,
  parseCheckpointCreateRequest,
  parseCheckpointJobMetadata,
} from './checkpoint-jobs.js';

function createMultipartRequest(formData: FormData): Request {
  return new Request('https://example.com/api/checkpoint/jobs', {
    method: 'POST',
    body: formData,
  });
}

export async function runCheckpointJobsApiTests(): Promise<void> {
  {
    const metadata = parseCheckpointJobMetadata(
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'a'.repeat(40),
          ref: 'main',
          projectRoot: 'apps/web',
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: false,
        },
      })
    );

    assert.equal(metadata.source.type, 'checkpoint');
    assert.equal(metadata.source.checkpointId, '8a513f56ed70');
    assert.equal(metadata.source.commitSha, 'a'.repeat(40));
    assert.equal(metadata.build.runTestsIfPresent, true);
    assert.equal(metadata.build.runLintIfPresent, false);
  }

  assert.throws(
    () =>
      parseCheckpointJobMetadata(
        JSON.stringify({
          source: { type: 'checkpoint', checkpointId: 'invalid', commitSha: 'short' },
          build: { runTestsIfPresent: true, runLintIfPresent: true },
        })
      ),
    /Invalid metadata.source.checkpointId/
  );

  assert.throws(
    () =>
      parseCheckpointJobMetadata(
        JSON.stringify({
          source: { type: 'checkpoint', checkpointId: '8a513f56ed70', commitSha: 'abc1234' },
          build: { runTestsIfPresent: true, runLintIfPresent: true },
        })
      ),
    /Invalid metadata.source.commitSha/
  );

  assert.throws(
    () =>
      parseCheckpointJobMetadata(
        JSON.stringify({
          source: {
            type: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: 'a'.repeat(40),
            projectRoot: '../..',
          },
          build: { runTestsIfPresent: true, runLintIfPresent: true },
        })
      ),
    /Invalid metadata.source.projectRoot/
  );

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'f'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([1, 2])], 'source.tar.gz', { type: 'application/gzip' }));

    const env = {
      SOURCE_BUNDLES: {
        async put(): Promise<void> {
          // no-op
        },
      },
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'job_any',
                    prompt: 'Deploy',
                    model: 'checkpoint',
                    status: 'queued',
                    phase: 'queued',
                    created_at: '2026-03-06T10:00:00.000Z',
                    started_at: null,
                    completed_at: null,
                    preview_url: null,
                    deployed_url: null,
                    error_message: null,
                    file_count: null,
                  } as T;
                },
              };
            },
          };
        },
      },
    } as unknown;

    const response = await handleCreateCheckpointJob(createMultipartRequest(form), env as never);
    assert.equal(response.status, 500);
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'b'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([1, 2, 3, 4])], 'source.tar.gz', { type: 'application/gzip' }));

    const parsed = await parseCheckpointCreateRequest(createMultipartRequest(form));

    assert.equal(parsed.metadata.source.commitSha, 'b'.repeat(40));
    assert.equal(parsed.bundleBytes, 4);
    assert.equal(parsed.bundleSha256.length, 64);
  }

  {
    const form = new FormData();
    form.set('bundle', new File([new Uint8Array([1])], 'source.tar.gz', { type: 'application/gzip' }));

    await assert.rejects(
      () => parseCheckpointCreateRequest(createMultipartRequest(form)),
      /Missing metadata form field/
    );
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: null,
          commitSha: 'c'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );

    const oversizedBytes = new Uint8Array(MAX_SOURCE_BUNDLE_BYTES + 1);
    form.set('bundle', new File([oversizedBytes], 'source.tar.gz', { type: 'application/gzip' }));

    await assert.rejects(
      () => parseCheckpointCreateRequest(createMultipartRequest(form)),
      /Source bundle exceeds max size/
    );
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'd'.repeat(40),
          ref: 'main',
          projectRoot: 'apps/web',
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([9, 8, 7, 6])], 'source.tar.gz', { type: 'application/gzip' }));

    const puts: Array<{ key: string; bytes: number }> = [];
    const inserts: unknown[][] = [];
    const queuedMessages: unknown[] = [];

    const env = {
      SOURCE_BUNDLES: {
        async put(key: string, value: unknown, options?: unknown): Promise<void> {
          const bytes = value instanceof ArrayBuffer ? value.byteLength : 0;
          const metadata = options as { customMetadata?: Record<string, string> } | undefined;
          assert.equal(metadata?.customMetadata?.source_project_root, 'apps/web');
          assert.equal(metadata?.customMetadata?.build_run_tests_if_present, 'true');
          assert.equal(metadata?.customMetadata?.build_run_lint_if_present, 'true');
          puts.push({ key, bytes });
        },
      },
      DB: {
        prepare() {
          return {
            bind(...values: unknown[]) {
              inserts.push(values);
              return {
                async first<T>() {
                  return {
                    id: values[0],
                    prompt: values[1],
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
                    checkpoint_id: values[2],
                    commit_sha: values[3],
                    source_ref: values[4],
                    source_project_root: values[5],
                    build_run_tests_if_present: values[6],
                    build_run_lint_if_present: values[7],
                    source_bundle_key: values[8],
                    source_bundle_sha256: values[9],
                    source_bundle_bytes: values[10],
                  } as T;
                },
              };
            },
          };
        },
      },
      CHECKPOINT_JOBS_QUEUE: {
        async send(body: unknown): Promise<void> {
          queuedMessages.push(body);
        },
      },
    } as unknown;

    const response = await handleCreateCheckpointJob(createMultipartRequest(form), env as never);
    assert.equal(response.status, 202);

    const payload = (await response.json()) as {
      jobId: string;
      status: string;
      phase: string;
      eventsUrl: string;
      jobUrl: string;
    };

    assert.match(payload.jobId, /^job_[a-z0-9]{8}$/);
    assert.equal(payload.status, 'queued');
    assert.equal(payload.phase, 'queued');
    assert.equal(payload.eventsUrl, `/api/jobs/${payload.jobId}/events`);
    assert.equal(payload.jobUrl, `/api/jobs/${payload.jobId}`);

    assert.equal(puts.length, 1);
    assert.equal(puts[0].bytes, 4);
    assert.equal(puts[0].key, `jobs/${payload.jobId}/source/${'d'.repeat(40)}.tar.gz`);

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][0], payload.jobId);
    assert.equal(inserts[0][2], '8a513f56ed70');
    assert.equal(inserts[0][3], 'd'.repeat(40));
    assert.equal(inserts[0][4], 'main');
    assert.equal(inserts[0][5], 'apps/web');
    assert.equal(inserts[0][6], 1);
    assert.equal(inserts[0][7], 1);

    assert.equal(queuedMessages.length, 1);
    const queuePayload = queuedMessages[0] as { type: string; jobId: string; queuedAt: string };
    assert.equal(queuePayload.type, 'checkpoint_job_created');
    assert.equal(queuePayload.jobId, payload.jobId);
    assert.equal(typeof queuePayload.queuedAt, 'string');
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'a'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([1, 2, 3, 4])], 'source.tar.gz', { type: 'application/gzip' }));

    let deletedJobs = 0;
    let deletedBundles = 0;
    let failedUpdates = 0;
    const cleanupOrder: string[] = [];
    let createdJobId: string | null = null;

    const env = {
      SOURCE_BUNDLES: {
        async put(): Promise<void> {
          // no-op
        },
        async delete(): Promise<void> {
          deletedBundles += 1;
          cleanupOrder.push('bundle_delete');
        },
      },
      CHECKPOINT_JOBS_QUEUE: {
        async send(): Promise<void> {
          throw new Error('queue unavailable');
        },
      },
      DB: {
        prepare(sql: string) {
          if (/^DELETE FROM jobs/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    deletedJobs += 1;
                    cleanupOrder.push('job_delete');
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET status = \?/i.test(sql)) {
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    failedUpdates += 1;
                    assert.equal(values[0], 'failed');
                    assert.equal(values[values.length - 1], createdJobId);
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  createdJobId = String(values[0]);
                  return {
                    id: values[0],
                    prompt: values[1],
                    model: 'checkpoint',
                    status: 'queued',
                    phase: 'queued',
                    created_at: '2026-03-06T10:00:00.000Z',
                    started_at: null,
                    completed_at: null,
                    preview_url: null,
                    deployed_url: null,
                    error_message: null,
                    file_count: null,
                  } as T;
                },
              };
            },
          };
        },
      },
    } as unknown;

    const response = await handleCreateCheckpointJob(createMultipartRequest(form), env as never);
    assert.equal(response.status, 500);
    assert.equal(deletedBundles, 1);
    assert.equal(deletedJobs, 1);
    assert.deepEqual(cleanupOrder, ['job_delete', 'bundle_delete']);
    assert.ok(createdJobId);
    assert.match(createdJobId as string, /^job_[a-z0-9]{8}$/);
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'b'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([5, 6, 7])], 'source.tar.gz', { type: 'application/gzip' }));

    let deletedJobs = 0;
    let deletedBundles = 0;
    let failedUpdates = 0;
    let createdJobId: string | null = null;

    const env = {
      SOURCE_BUNDLES: {
        async put(): Promise<void> {
          // no-op
        },
        async delete(): Promise<void> {
          deletedBundles += 1;
        },
      },
      CHECKPOINT_JOBS_QUEUE: {
        async send(): Promise<void> {
          throw new Error('queue unavailable');
        },
      },
      DB: {
        prepare(sql: string) {
          if (/^DELETE FROM jobs/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    deletedJobs += 1;
                    throw new Error('delete failed');
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET status = \?/i.test(sql)) {
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    failedUpdates += 1;
                    assert.equal(values[0], 'failed');
                    assert.equal(values[values.length - 1], createdJobId);
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          return {
            bind(...values: unknown[]) {
              return {
                async first<T>() {
                  createdJobId = String(values[0]);
                  return {
                    id: values[0],
                    prompt: values[1],
                    model: 'checkpoint',
                    status: 'queued',
                    phase: 'queued',
                    created_at: '2026-03-06T10:00:00.000Z',
                    started_at: null,
                    completed_at: null,
                    preview_url: null,
                    deployed_url: null,
                    error_message: null,
                    file_count: null,
                  } as T;
                },
              };
            },
          };
        },
      },
    } as unknown;

    const response = await handleCreateCheckpointJob(createMultipartRequest(form), env as never);
    assert.equal(response.status, 500);
    assert.equal(deletedJobs, 1);
    assert.equal(deletedBundles, 0);
    assert.equal(failedUpdates, 1);
    assert.ok(createdJobId);
    assert.match(createdJobId as string, /^job_[a-z0-9]{8}$/);
  }

  {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({
        source: {
          type: 'checkpoint',
          checkpointId: '8a513f56ed70',
          commitSha: 'e'.repeat(40),
        },
        build: {
          runTestsIfPresent: true,
          runLintIfPresent: true,
        },
      })
    );
    form.set('bundle', new File([new Uint8Array([1, 1, 1, 1])], 'source.tar.gz', { type: 'application/gzip' }));

    const puts: string[] = [];
    const deletes: string[] = [];

    const env = {
      SOURCE_BUNDLES: {
        async put(key: string): Promise<void> {
          puts.push(key);
        },
        async delete(key: string): Promise<void> {
          deletes.push(key);
        },
      },
      DB: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  throw new Error('db unavailable');
                },
              };
            },
          };
        },
      },
      CHECKPOINT_JOBS_QUEUE: {
        async send(): Promise<void> {
          // no-op
        },
      },
    } as unknown;

    const response = await handleCreateCheckpointJob(createMultipartRequest(form), env as never);
    assert.equal(response.status, 500);
    assert.equal(puts.length, 1);
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0], puts[0]);
  }
}
