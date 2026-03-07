import { strict as assert } from 'assert';
import {
  createCheckpointJobQueueMessage,
  parseCheckpointJobQueueMessage,
} from './checkpoint-queue.js';

export function runCheckpointQueueTests(): void {
  {
    const created = createCheckpointJobQueueMessage('job_abc12345');
    assert.equal(created.type, 'checkpoint_job_created');
    assert.equal(created.jobId, 'job_abc12345');
    assert.equal(typeof created.queuedAt, 'string');
  }

  {
    const parsed = parseCheckpointJobQueueMessage({
      type: 'checkpoint_job_created',
      jobId: 'job_abc12345',
      queuedAt: '2026-03-06T10:00:00.000Z',
    });

    assert.equal(parsed.type, 'checkpoint_job_created');
    assert.equal(parsed.jobId, 'job_abc12345');
  }

  assert.throws(
    () => parseCheckpointJobQueueMessage({ type: 'checkpoint_job_created', jobId: 'invalid', queuedAt: '2026-03-06' }),
    /jobId/
  );

  assert.throws(
    () =>
      parseCheckpointJobQueueMessage({
        type: 'checkpoint_job_created',
        jobId: 'job_abc12345',
        queuedAt: 'invalid',
      }),
    /queuedAt/
  );
}
