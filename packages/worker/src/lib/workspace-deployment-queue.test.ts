import { strict as assert } from 'assert';
import {
  createWorkspaceDeploymentQueueMessage,
  parseWorkspaceDeploymentQueueMessage,
} from './workspace-deployment-queue.js';

export async function runWorkspaceDeploymentQueueTests(): Promise<void> {
  const message = createWorkspaceDeploymentQueueMessage('ws_abc12345', 'dep_abcd1234');
  assert.equal(message.type, 'workspace_deployment_requested');
  assert.equal(message.workspaceId, 'ws_abc12345');
  assert.equal(message.deploymentId, 'dep_abcd1234');
  assert.equal(Number.isNaN(Date.parse(message.queuedAt)), false);

  const parsed = parseWorkspaceDeploymentQueueMessage(message);
  assert.deepEqual(parsed, message);

  assert.throws(
    () => parseWorkspaceDeploymentQueueMessage({ type: 'workspace_deployment_requested', workspaceId: 'bad id' }),
    /workspaceId/
  );
}
