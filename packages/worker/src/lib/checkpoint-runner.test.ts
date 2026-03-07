import { strict as assert } from 'assert';
import { isValidBase64ChunkSize, processCheckpointJob } from './checkpoint-runner.js';

export async function runCheckpointRunnerTests(): Promise<void> {
  assert.equal(isValidBase64ChunkSize(510 * 1024), true);
  assert.equal(isValidBase64ChunkSize(512 * 1024), false);

  {
    const updates: Array<{ status: string; phase: string }> = [];

    const env = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
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
                      preview_url: null,
                      deployed_url: null,
                      error_message: null,
                      file_count: null,
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: 'apps/web',
                      build_run_tests_if_present: 1,
                      build_run_lint_if_present: 1,
                      source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 1234,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    updates.push({ status: 'running', phase: 'building' });
                    return { success: true, meta: { changes: 1 } };
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
                    updates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return { last_event_seq: 1 } as T;
                  },
                };
              },
            };
          }

          if (/^INSERT INTO job_events/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    throw new Error('event insert failed');
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: undefined,
    } as never;

    await assert.rejects(() => processCheckpointJob(env, 'job_abc12345'), /Failed to append job_started event/);
    assert.deepEqual(updates, [
      { status: 'running', phase: 'building' },
      { status: 'queued', phase: 'queued' },
    ]);
  }

  const updates: Array<{ status: string; phase: string }> = [];

  const env = {
    DB: {
      prepare(sql: string) {
        if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
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
                    preview_url: null,
                    deployed_url: null,
                    error_message: null,
                    file_count: null,
                    source_type: 'checkpoint',
                    checkpoint_id: '8a513f56ed70',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: 'apps/web',
                    build_run_tests_if_present: 1,
                    build_run_lint_if_present: 1,
                    source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                    source_bundle_sha256: 'f'.repeat(64),
                    source_bundle_bytes: 1234,
                  } as T;
                },
              };
            },
          };
        }

        if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  updates.push({ status: 'running', phase: 'building' });
                  return { success: true, meta: { changes: 1 } };
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
                  updates.push({
                    status: String(values[0]),
                    phase: String(values[1]),
                  });
                  return { success: true, meta: { duration: 0 } };
                },
              };
            },
          };
        }

        if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { last_event_seq: 1 } as T;
                },
              };
            },
          };
        }

        if (/^INSERT INTO job_events/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { duration: 0 } };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
    Sandbox: {},
    SOURCE_BUNDLES: undefined,
  } as never;

  await assert.rejects(() => processCheckpointJob(env, 'job_abc12345'), /SOURCE_BUNDLES binding is not configured/);

  assert.deepEqual(updates, [
    { status: 'running', phase: 'building' },
    { status: 'queued', phase: 'queued' },
  ]);

  {
    const runningUpdates: Array<{ status: string; phase: string }> = [];

    const runningEnv = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'job_abc12345',
                      prompt: 'Deploy checkpoint 8a513f56ed70',
                      model: 'checkpoint',
                      status: 'running',
                      phase: 'building',
                      created_at: '2026-03-06T10:00:00.000Z',
                      started_at: '2026-03-06T10:00:01.000Z',
                      completed_at: null,
                      preview_url: null,
                      deployed_url: null,
                      error_message: null,
                      file_count: null,
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: 'apps/web',
                      build_run_tests_if_present: 1,
                      build_run_lint_if_present: 1,
                      source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 1234,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    throw new Error('should not claim already running jobs');
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
                    runningUpdates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return { last_event_seq: 1 } as T;
                  },
                };
              },
            };
          }

          if (/^INSERT INTO job_events/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: undefined,
    } as never;

    await processCheckpointJob(runningEnv, 'job_abc12345');

    assert.deepEqual(runningUpdates, []);
  }

  {
    const claimAttempts: string[] = [];
    const claimContentionUpdates: Array<{ status: string; phase: string }> = [];

    const claimContentionEnv = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
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
                      preview_url: null,
                      deployed_url: null,
                      error_message: null,
                      file_count: null,
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: 'apps/web',
                      build_run_tests_if_present: 1,
                      build_run_lint_if_present: 1,
                      source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 1234,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    claimAttempts.push('claim');
                    return { success: true, meta: { changes: 0 } };
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
                    claimContentionUpdates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    throw new Error('should not append events when claim is contended');
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: undefined,
    } as never;

    await processCheckpointJob(claimContentionEnv, 'job_abc12345');
    assert.deepEqual(claimAttempts, ['claim']);
    assert.deepEqual(claimContentionUpdates, []);
  }

  {
    const failedUpdates: Array<{ status: string; phase: string }> = [];

    const failedEnv = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'job_abc12345',
                      prompt: 'Deploy checkpoint 8a513f56ed70',
                      model: 'checkpoint',
                      status: 'failed',
                      phase: 'failed',
                      created_at: '2026-03-06T10:00:00.000Z',
                      started_at: '2026-03-06T10:00:01.000Z',
                      completed_at: '2026-03-06T10:00:03.000Z',
                      preview_url: null,
                      deployed_url: null,
                      error_message: 'previous failure',
                      file_count: null,
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: 'apps/web',
                      build_run_tests_if_present: 1,
                      build_run_lint_if_present: 1,
                      source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 1234,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    throw new Error('should not claim failed jobs');
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
                    failedUpdates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return { last_event_seq: 1 } as T;
                  },
                };
              },
            };
          }

          if (/^INSERT INTO job_events/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: undefined,
    } as never;

    await processCheckpointJob(failedEnv, 'job_abc12345');
    assert.deepEqual(failedUpdates, []);
  }

  {
    const nonCheckpointUpdates: Array<{ status: string; phase: string }> = [];

    const nonCheckpointEnv = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    return {
                      id: 'job_prompt123',
                      prompt: 'Build a landing page',
                      model: 'gpt-5',
                      status: 'queued',
                      phase: 'queued',
                      created_at: '2026-03-06T10:00:00.000Z',
                      started_at: null,
                      completed_at: null,
                      preview_url: null,
                      deployed_url: null,
                      error_message: null,
                      file_count: null,
                      source_type: null,
                      checkpoint_id: null,
                      commit_sha: null,
                      source_ref: null,
                      source_project_root: null,
                      build_run_tests_if_present: null,
                      build_run_lint_if_present: null,
                      source_bundle_key: null,
                      source_bundle_sha256: null,
                      source_bundle_bytes: null,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    throw new Error('should not claim non-checkpoint jobs');
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
                    nonCheckpointUpdates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    throw new Error('should not append events for non-checkpoint jobs');
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: undefined,
    } as never;

    await processCheckpointJob(nonCheckpointEnv, 'job_prompt123');
    assert.deepEqual(nonCheckpointUpdates, []);
  }

  {
    const eventFailures: string[] = [];
    const failedStatusUpdates: Array<{ status: string; phase: string }> = [];

    const nonRetryFailureEnv = {
      DB: {
        prepare(sql: string) {
          if (/^SELECT \* FROM jobs WHERE id = \?/i.test(sql)) {
            return {
              bind() {
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
                      preview_url: null,
                      deployed_url: null,
                      error_message: null,
                      file_count: null,
                      source_type: 'checkpoint',
                      checkpoint_id: '8a513f56ed70',
                      commit_sha: 'a'.repeat(40),
                      source_ref: 'main',
                      source_project_root: 'apps/web',
                      build_run_tests_if_present: 1,
                      build_run_lint_if_present: 1,
                      source_bundle_key: 'jobs/job_abc12345/source/a.tar.gz',
                      source_bundle_sha256: 'f'.repeat(64),
                      source_bundle_bytes: 1234,
                    } as T;
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs\s+SET status = 'running'/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    return { success: true, meta: { changes: 1 } };
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
                    failedStatusUpdates.push({
                      status: String(values[0]),
                      phase: String(values[1]),
                    });
                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          if (/^UPDATE jobs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
            return {
              bind() {
                return {
                  async first<T>() {
                    const nextSeq = eventFailures.length + 1;
                    return { last_event_seq: nextSeq } as T;
                  },
                };
              },
            };
          }

          if (/^INSERT INTO job_events/i.test(sql)) {
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    const eventType = String(values[3]);
                    if (eventType === 'job_failed') {
                      eventFailures.push('job_failed');
                      throw new Error('job_failed event insert failed');
                    }

                    return { success: true, meta: { duration: 0 } };
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected SQL in test: ${sql}`);
        },
      },
      Sandbox: {},
      SOURCE_BUNDLES: {
        async get() {
          return null;
        },
      },
    } as never;

    await processCheckpointJob(nonRetryFailureEnv, 'job_abc12345');

    assert.deepEqual(failedStatusUpdates, [{ status: 'failed', phase: 'failed' }]);
    assert.deepEqual(eventFailures, ['job_failed']);
  }
}
