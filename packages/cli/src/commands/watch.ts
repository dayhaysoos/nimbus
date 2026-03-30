import * as p from '@clack/prompts';
import {
  describeWatchedJobStatus,
  formatCancelledJobLines,
  formatCompletedJobLines,
  formatFailedJobLines,
  formatWatchTimeoutLines,
  watchJobUntilTerminal,
} from '../app/jobs/watch.js';
import { getWorkerUrl } from '../clients/worker/shared.js';

/**
 * Watch command - poll job status until completion
 */
export async function watchCommand(jobId: string): Promise<void> {
  const workerUrl = getWorkerUrl();

  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    process.exit(1);
  }

  const spinner = p.spinner();

  try {
    spinner.start(`Watching job ${jobId}...`);
    const outcome = await watchJobUntilTerminal(workerUrl, jobId, {
      onStatusChange: (job) => {
        const message = describeWatchedJobStatus(job);
        if (message) {
          spinner.message(message);
        }
      },
    });

    if (outcome.kind === 'completed') {
      spinner.stop('Job completed');
      console.log('');
      p.log.success('Build completed successfully!');
      console.log('');
      if (outcome.job.previewUrl) {
        p.log.info(`Sandbox URL: ${outcome.job.previewUrl}`);
      }
      if (outcome.job.deployedUrl) {
        p.outro(`Deployed: ${outcome.job.deployedUrl}`);
      }
      renderLines(formatCompletedJobLines(outcome.job));
      process.exit(0);
    }

    if (outcome.kind === 'failed') {
      spinner.stop('Job failed');
      console.log('');
      p.log.error('Build failed');
      console.log('');
      if (outcome.job.errorMessage) {
        p.log.error(outcome.job.errorMessage);
      }
      if (outcome.job.previewUrl) {
        console.log('');
        p.log.info(`Sandbox URL: ${outcome.job.previewUrl}`);
      }
      renderLines(formatFailedJobLines(outcome.job));
      process.exit(1);
    }

    if (outcome.kind === 'cancelled') {
      spinner.stop('Job cancelled');
      console.log('');
      p.log.warning('Build cancelled');
      console.log('');
      renderLines(formatCancelledJobLines(outcome.job));
      process.exit(1);
    }

    spinner.stop('Timeout');
    const timeoutLines = formatWatchTimeoutLines(outcome);
    p.log.warning(timeoutLines[0] ?? 'Job watch timed out.');
    for (const line of timeoutLines.slice(1)) {
      p.log.info(line);
    }
    process.exit(1);
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

function renderLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}
