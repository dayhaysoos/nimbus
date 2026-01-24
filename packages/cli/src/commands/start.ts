import * as p from '@clack/prompts';
import { getWorkerUrl, createJob, parseSSE } from '../lib/api.js';
import { showModelPicker, getDefaultModel } from '../lib/models.js';
import { printSummary } from '../lib/summary.js';
import { saveReport } from '../lib/report.js';
import type { SSEEvent } from '../lib/types.js';

interface StartOptions {
  model?: string;
}

/**
 * Start command - creates a new job and streams progress
 */
export async function startCommand(prompt: string, options: StartOptions): Promise<void> {
  const workerUrl = getWorkerUrl();

  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    p.log.info('Set it to your self-hosted Nimbus worker URL.');
    p.log.info('');
    p.log.info('Example:');
    p.log.info('  NIMBUS_WORKER_URL=https://your-worker.com nimbus start "your prompt"');
    p.log.info('');
    p.log.info('Self-hosting guide: https://github.com/dayhaysoos/nimbus#self-hosting-guide');
    process.exit(1);
  }

  // Get model - either from flag or show picker
  let model: string;
  if (options.model) {
    model = options.model;
  } else {
    const selected = await showModelPicker();
    model = selected;
  }

  const spinner = p.spinner();
  let jobId: string | undefined;

  try {
    spinner.start('Creating job...');

    const response = await createJob(workerUrl, prompt, model);

    if (!response.body) {
      throw new Error('No response body from worker');
    }

    const reader = response.body.getReader();

    for await (const event of parseSSE(reader)) {
      await handleEvent(event, spinner, (id) => {
        jobId = id;
      });
    }
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);

    if (jobId) {
      p.log.info(`Job ID: ${jobId}`);
      p.log.info(`Check status with: nimbus watch ${jobId}`);
    }

    process.exit(1);
  }
}

/**
 * Handle SSE events and update UI
 */
async function handleEvent(
  event: SSEEvent,
  spinner: ReturnType<typeof p.spinner>,
  setJobId: (id: string) => void
): Promise<void> {
  switch (event.type) {
    case 'job_created':
      setJobId(event.jobId);
      spinner.stop(`Job created: ${event.jobId}`);
      spinner.start('Sending to LLM...');
      break;

    case 'generating':
      spinner.message('Generating code...');
      break;

    case 'generated':
      spinner.stop(`Generated ${event.fileCount} files`);
      spinner.start('Building in sandbox...');
      break;

    case 'scaffolding':
      spinner.message('Scaffolding project...');
      break;

    case 'writing':
      spinner.message('Writing generated files...');
      break;

    case 'installing':
      spinner.message('Installing dependencies...');
      break;

    case 'building':
      spinner.message('Building project...');
      break;

    case 'log': {
      const prefix = event.phase === 'install' ? 'install' : 'build';
      const lines = event.message.split('\n');
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        p.log.info(`[${prefix}] ${line}`);
      }
      break;
    }

    case 'starting':
      spinner.stop('Build complete');
      spinner.start('Starting preview server...');
      break;

    case 'preview_ready':
      spinner.stop('Preview ready');
      p.log.info(`Preview: ${event.previewUrl}`);
      break;

    case 'deploying':
      spinner.start('Deploying...');
      break;

    case 'deploy_warning':
      spinner.stop('Deployment failed');
      p.log.warning(event.message);
      p.log.info('Falling back to preview URL (temporary)');
      break;

    case 'deployed':
      spinner.stop('Deployment complete');
      break;

    case 'complete': {
      spinner.stop('Done');

      // Print summary box
      printSummary(event.metrics);

      // Generate and save report
      try {
        const filename = await saveReport(event.metrics);
        console.log('');
        console.log(`Report saved: ./${filename}`);
        console.log('');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.log.warning(`Failed to save report: ${message}`);
      }

      // Print final URL
      if (event.isPreviewFallback) {
        p.outro(`Preview (temporary): ${event.deployedUrl}`);
      } else {
        p.outro(`Deployed: ${event.deployedUrl}`);
      }
      process.exit(0);
      break;
    }

    case 'error':
      spinner.stop('Failed');
      p.log.error(event.message);
      process.exit(1);
  }
}
