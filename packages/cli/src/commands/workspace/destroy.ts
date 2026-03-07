import * as p from '@clack/prompts';
import { deleteWorkspace, getWorkerUrl } from '../../lib/api.js';

export async function destroyWorkspaceCommand(workspaceId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace commands.');
  }

  const result = await deleteWorkspace(workerUrl, workspaceId);
  if (result.status === 'deleted') {
    p.log.success(`Workspace deleted: ${workspaceId}`);
    return;
  }

  p.log.info(`Workspace ${workspaceId} response: ${result.status}`);
}
