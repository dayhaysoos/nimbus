import * as p from '@clack/prompts';
import { getWorkerUrl, getWorkspace } from '../../lib/api.js';

export async function showWorkspaceCommand(workspaceId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace commands.');
  }

  const workspace = await getWorkspace(workerUrl, workspaceId);

  p.log.info(`Workspace ${workspace.id}`);
  console.log('');
  console.log(`  Status:         ${workspace.status}`);
  console.log(`  Commit SHA:     ${workspace.commitSha}`);
  console.log(`  Checkpoint ID:  ${workspace.checkpointId ?? 'none'}`);
  console.log(`  Source Ref:     ${workspace.sourceRef ?? 'none'}`);
  console.log(`  Project Root:   ${workspace.sourceProjectRoot ?? '.'}`);
  console.log(`  Baseline Ready: ${workspace.baselineReady ? 'yes' : 'no'}`);
  console.log(`  Sandbox ID:     ${workspace.sandboxId}`);
  console.log(`  Events URL:     ${workspace.eventsUrl}`);
  console.log(`  Created At:     ${workspace.createdAt}`);
  console.log(`  Updated At:     ${workspace.updatedAt}`);
  if (workspace.deletedAt) {
    console.log(`  Deleted At:     ${workspace.deletedAt}`);
  }
  if (workspace.errorMessage) {
    console.log(`  Error:          ${workspace.errorMessage}`);
  }
}
