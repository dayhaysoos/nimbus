const DEPLOYMENT_ID_REGEX = /^[a-z0-9_]+$/;
const WORKSPACE_ID_REGEX = /^[a-z0-9_]+$/;

export interface WorkspaceDeploymentQueueMessage {
  type: 'workspace_deployment_requested';
  workspaceId: string;
  deploymentId: string;
  queuedAt: string;
}

export function createWorkspaceDeploymentQueueMessage(
  workspaceId: string,
  deploymentId: string
): WorkspaceDeploymentQueueMessage {
  return {
    type: 'workspace_deployment_requested',
    workspaceId,
    deploymentId,
    queuedAt: new Date().toISOString(),
  };
}

export function parseWorkspaceDeploymentQueueMessage(payload: unknown): WorkspaceDeploymentQueueMessage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid workspace deployment queue payload: expected object');
  }

  const record = payload as Record<string, unknown>;
  if (record.type !== 'workspace_deployment_requested') {
    throw new Error('Invalid workspace deployment queue payload type');
  }
  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_REGEX.test(record.workspaceId)) {
    throw new Error('Invalid workspace deployment queue payload workspaceId');
  }
  if (typeof record.deploymentId !== 'string' || !DEPLOYMENT_ID_REGEX.test(record.deploymentId)) {
    throw new Error('Invalid workspace deployment queue payload deploymentId');
  }
  if (typeof record.queuedAt !== 'string' || Number.isNaN(Date.parse(record.queuedAt))) {
    throw new Error('Invalid workspace deployment queue payload queuedAt');
  }

  return {
    type: 'workspace_deployment_requested',
    workspaceId: record.workspaceId,
    deploymentId: record.deploymentId,
    queuedAt: record.queuedAt,
  };
}
