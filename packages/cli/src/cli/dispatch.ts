import * as p from '@clack/prompts';
import { doctorCommand } from '../commands/doctor.js';
import { listCommand } from '../commands/list.js';
import { watchCommand } from '../commands/watch.js';
import { dispatchAdminCommand } from './dispatch/admin.js';
import { dispatchAuthCommand } from './dispatch/auth.js';
import { dispatchDeployCommand } from './dispatch/deploy.js';
import { dispatchReviewCommand } from './dispatch/review.js';
import { dispatchRepoCommand } from './dispatch/repo.js';
import { dispatchWorkspaceCommand } from './dispatch/workspace.js';
import type { ParsedCliArgs } from '../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

function exitWithUsage(message: string): never {
  p.log.error(message);
  process.exit(1);
}

export async function dispatchCliCommand({ command, flags, positional }: ParsedCliArgs): Promise<void> {
  switch (command) {
    case 'doctor': {
      await doctorCommand();
      return;
    }

    case 'deploy': {
      await dispatchDeployCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'workspace': {
      await dispatchWorkspaceCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'review': {
      await dispatchReviewCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'admin': {
      await dispatchAdminCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'repo': {
      await dispatchRepoCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'auth': {
      await dispatchAuthCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'list': {
      await listCommand();
      return;
    }

    case 'watch': {
      const jobId = positional[0];
      if (!jobId) {
        exitWithUsage('Missing job ID. Usage: nimbus watch <job-id>');
      }
      await watchCommand(jobId);
      return;
    }

    default: {
      p.log.error(`Unknown command: ${command}`);
      p.log.info('Run "nimbus --help" for usage information.');
      process.exit(1);
    }
  }
}
