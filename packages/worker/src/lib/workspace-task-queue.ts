const TASK_ID_REGEX = /^[a-z0-9_]+$/;
const WORKSPACE_ID_REGEX = /^[a-z0-9_]+$/;

export interface WorkspaceTaskQueueMessage {
  type: 'workspace_task_created';
  workspaceId: string;
  taskId: string;
  queuedAt: string;
}

export function createWorkspaceTaskQueueMessage(
  workspaceId: string,
  taskId: string
): WorkspaceTaskQueueMessage {
  return {
    type: 'workspace_task_created',
    workspaceId,
    taskId,
    queuedAt: new Date().toISOString(),
  };
}

export function parseWorkspaceTaskQueueMessage(payload: unknown): WorkspaceTaskQueueMessage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid workspace task queue payload: expected object');
  }

  const record = payload as Record<string, unknown>;
  if (record.type !== 'workspace_task_created') {
    throw new Error('Invalid workspace task queue payload type');
  }

  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_REGEX.test(record.workspaceId)) {
    throw new Error('Invalid workspace task queue payload workspaceId');
  }

  if (typeof record.taskId !== 'string' || !TASK_ID_REGEX.test(record.taskId)) {
    throw new Error('Invalid workspace task queue payload taskId');
  }

  if (typeof record.queuedAt !== 'string' || Number.isNaN(Date.parse(record.queuedAt))) {
    throw new Error('Invalid workspace task queue payload queuedAt');
  }

  return {
    type: 'workspace_task_created',
    workspaceId: record.workspaceId,
    taskId: record.taskId,
    queuedAt: record.queuedAt,
  };
}
