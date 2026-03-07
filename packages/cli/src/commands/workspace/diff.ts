import * as p from '@clack/prompts';
import { getWorkerUrl, getWorkspaceDiff } from '../../lib/api.js';

export interface WorkspaceDiffCommandOptions {
  includePatch?: boolean;
  maxBytes?: number;
}

export async function workspaceDiffCommand(
  workspaceId: string,
  options: WorkspaceDiffCommandOptions
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace commands.');
  }

  const diff = await getWorkspaceDiff(workerUrl, workspaceId, {
    includePatch: options.includePatch,
    maxBytes: options.maxBytes,
  });

  p.log.info(`Workspace ${workspaceId} diff`);
  console.log('');
  console.log(`  Changed files: ${diff.summary.totalChanged}`);
  console.log(`  Added:         ${diff.summary.added}`);
  console.log(`  Modified:      ${diff.summary.modified}`);
  console.log(`  Deleted:       ${diff.summary.deleted}`);
  console.log(`  Renamed:       ${diff.summary.renamed}`);
  console.log(`  Truncated:     ${diff.truncated ? 'yes' : 'no'}`);

  if (diff.changedFiles.length > 0) {
    console.log('');
    console.log('  Files:');
    for (const file of diff.changedFiles) {
      if (file.status === 'renamed' && file.previousPath) {
        console.log(`    R  ${file.previousPath} -> ${file.path}`);
      } else {
        const prefix = file.status[0]?.toUpperCase() ?? '?';
        console.log(`    ${prefix}  ${file.path}`);
      }
    }
  }

  if (options.includePatch) {
    console.log('');
    console.log(diff.patch ?? '');
    if (diff.patchTruncated) {
      const knownTotal = typeof diff.patchTotalBytes === 'number' ? diff.patchTotalBytes : null;
      if (knownTotal !== null) {
        p.log.warn(
          `Patch output truncated (${diff.patchBytes ?? 0}/${knownTotal} bytes). Increase --max-bytes or inspect files directly with workspace cat.`
        );
      } else {
        p.log.warn(
          `Patch output truncated at ${diff.patchBytes ?? 0} bytes (total size unknown). Increase --max-bytes or inspect files directly with workspace cat.`
        );
      }
    }
  }

  if (diff.changedFilesTruncated) {
    if (diff.summaryIsPartial) {
      p.log.warn(
        `Diff metadata truncated (${diff.changedFiles.length} files shown; total changed is at least ${diff.summary.totalChanged}). Increase --max-bytes for more.`
      );
    } else {
      p.log.warn(
        `Diff metadata truncated (${diff.changedFiles.length}/${diff.summary.totalChanged} files shown). Increase --max-bytes for more.`
      );
    }
  }
}
