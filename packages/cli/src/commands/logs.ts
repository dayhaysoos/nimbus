import * as p from '@clack/prompts';
import { getAuthToken, getJobLogs, getWorkerUrl } from '../lib/api.js';

interface LogOptions {
  type?: string;
}

const VALID_LOG_TYPES = ['build', 'deploy'] as const;

export async function logsCommand(jobId: string, options: LogOptions): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    process.exit(1);
  }

  const authToken = getAuthToken();
  if (!authToken) {
    p.log.error('NIMBUS_AUTH_TOKEN (or AUTH_TOKEN) is required to fetch logs.');
    process.exit(1);
  }

  const requestedType = options.type?.toLowerCase();
  const types = requestedType
    ? ([requestedType] as string[])
    : [...VALID_LOG_TYPES];

  for (const type of types) {
    if (!VALID_LOG_TYPES.includes(type as (typeof VALID_LOG_TYPES)[number])) {
      p.log.error(`Invalid log type: ${type}. Use "build" or "deploy".`);
      process.exit(1);
    }
  }

  for (const type of types) {
    try {
      const logContents = await getJobLogs(
        workerUrl,
        jobId,
        type as (typeof VALID_LOG_TYPES)[number],
        authToken
      );

      console.log('');
      console.log(`--- ${type} log ---`);
      console.log(logContents.trim() || '(empty)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Job not found')) {
        p.log.error(`Job not found: ${jobId}`);
        process.exit(1);
      }
      if (message.includes('(404)')) {
        console.log('');
        console.log(`--- ${type} log ---`);
        console.log('(not available)');
        continue;
      }
      throw error;
    }
  }
}
