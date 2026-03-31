import * as p from '@clack/prompts';
import { loadListedJobsView } from '../app/jobs/list.js';
import { getWorkerUrl } from '../clients/worker/shared.js';

/**
 * List command - shows all past jobs
 */
export async function listCommand(): Promise<void> {
  const workerUrl = getWorkerUrl();

  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    process.exit(1);
  }

  const spinner = p.spinner();

  try {
    spinner.start('Fetching jobs...');

    const view = await loadListedJobsView(workerUrl);

    spinner.stop('Jobs retrieved');

    if (view.emptyMessage) {
      p.log.info(view.emptyMessage);
      return;
    }

    for (const line of view.lines) {
      console.log(line);
    }

    p.log.info(view.totalLine ?? `${view.jobs.length} job(s) total`);
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}
