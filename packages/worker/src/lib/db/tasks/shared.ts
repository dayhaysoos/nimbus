import type { WorkspaceTaskRecord, WorkspaceTaskResponse } from '../../../types.js';

export interface WorkspaceTaskEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkspaceTaskEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

export class WorkspaceTaskIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Task idempotency key conflict: ${key}`);
    this.name = 'WorkspaceTaskIdempotencyConflictError';
  }
}

export function toWorkspaceTaskResponse(record: WorkspaceTaskRecord): WorkspaceTaskResponse {
  const result = parseJsonOrFallback(record.result_json, undefined);

  const response: WorkspaceTaskResponse = {
    id: record.id,
    workspaceId: record.workspace_id,
    status: record.status,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    idempotencyKey: record.idempotency_key,
    maxSteps: record.max_steps,
    maxRetries: record.max_retries,
    attemptCount: record.attempt_count,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    cancelRequestedAt: record.cancel_requested_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  if (result !== undefined) {
    response.result = result;
  }

  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
    };
  }

  return response;
}
