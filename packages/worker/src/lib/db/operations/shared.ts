import type {
  WorkspaceOperationRecord,
  WorkspaceOperationResponse,
  WorkspaceOperationType,
} from '../../../types.js';

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

export class WorkspaceIdempotencyConflictError extends Error {
  constructor(public readonly key: string, public readonly type: WorkspaceOperationType) {
    super(`Idempotency key conflict for ${type}: ${key}`);
    this.name = 'WorkspaceIdempotencyConflictError';
  }
}

export function toWorkspaceOperationResponse(record: WorkspaceOperationRecord): WorkspaceOperationResponse {
  const warnings = parseJsonOrFallback<unknown[]>(record.warnings_json, []);
  const result = parseJsonOrFallback<unknown>(record.result_json, undefined);
  const errorDetails = parseJsonOrFallback<unknown>(record.error_details_json, undefined);

  const response: WorkspaceOperationResponse = {
    id: record.id,
    type: record.type,
    status: record.status,
    workspaceId: record.workspace_id,
    idempotencyKey: record.idempotency_key,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  if (result !== undefined) {
    response.result = result;
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    response.warnings = warnings;
  }
  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
      details: errorDetails,
    };
  }

  return response;
}

export function generateWorkspaceOperationId(): string {
  return generatePrefixedId('op');
}
