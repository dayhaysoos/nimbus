import * as p from '@clack/prompts';
import { getWorkerUrl, getWorkspaceFile } from '../../lib/api.js';

export async function catWorkspaceFileCommand(
  workspaceId: string,
  path: string,
  maxBytes?: number
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace commands.');
  }

  const response = await getWorkspaceFile(workerUrl, workspaceId, path, maxBytes);
  p.log.info(`Workspace ${workspaceId} file ${response.path}`);
  console.log('');
  console.log(response.content);

  if (response.truncated) {
    p.log.warn(
      `Output truncated at ${response.maxBytes} bytes (file size ${response.sizeBytes ?? 'unknown'} bytes). Use --max-bytes to increase.`
    );
  }
}
