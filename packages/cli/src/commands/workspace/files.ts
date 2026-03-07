import * as p from '@clack/prompts';
import { getWorkerUrl, listWorkspaceFiles } from '../../lib/api.js';

export async function listWorkspaceFilesCommand(workspaceId: string, path?: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace commands.');
  }

  const response = await listWorkspaceFiles(workerUrl, workspaceId, path);
  p.log.info(`Workspace ${workspaceId} files (${response.path})`);

  if (response.entries.length === 0) {
    console.log('');
    console.log('  (empty)');
    return;
  }

  console.log('');
  for (const entry of response.entries) {
    const suffix = entry.type === 'directory' ? '/' : '';
    console.log(`  ${entry.path}${suffix}`);
  }
}
