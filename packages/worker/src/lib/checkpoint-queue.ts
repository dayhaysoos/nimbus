const JOB_ID_REGEX = /^job_[a-z0-9]{8}$/;

export interface CheckpointJobQueueMessage {
  type: 'checkpoint_job_created';
  jobId: string;
  queuedAt: string;
}

export function createCheckpointJobQueueMessage(jobId: string): CheckpointJobQueueMessage {
  return {
    type: 'checkpoint_job_created',
    jobId,
    queuedAt: new Date().toISOString(),
  };
}

export function parseCheckpointJobQueueMessage(payload: unknown): CheckpointJobQueueMessage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid checkpoint queue payload: expected object');
  }

  const record = payload as Record<string, unknown>;

  if (record.type !== 'checkpoint_job_created') {
    throw new Error('Invalid checkpoint queue payload type');
  }

  if (typeof record.jobId !== 'string' || !JOB_ID_REGEX.test(record.jobId)) {
    throw new Error('Invalid checkpoint queue payload jobId');
  }

  if (typeof record.queuedAt !== 'string' || Number.isNaN(Date.parse(record.queuedAt))) {
    throw new Error('Invalid checkpoint queue payload queuedAt');
  }

  return {
    type: 'checkpoint_job_created',
    jobId: record.jobId,
    queuedAt: record.queuedAt,
  };
}
