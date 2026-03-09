import * as p from '@clack/prompts';
import { getDeployReadiness, getWorkerUrl } from '../lib/api.js';

function checkLine(code: string, ok: boolean, details?: string): string {
  return `- ${code}: ${ok ? 'ok' : details ?? 'failed'}`;
}

export async function doctorCommand(): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required.');
  }

  p.log.message(`Worker URL: ${workerUrl}`);

  let readiness;
  try {
    readiness = await getDeployReadiness(workerUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Worker error (404)')) {
      throw new Error(
        'Worker is reachable but /api/system/deploy-readiness is missing. Redeploy worker from this branch to get Phase 6 diagnostics.'
      );
    }
    throw error;
  }

  p.log.message('Deploy readiness checks:');
  for (const check of readiness.checks) {
    p.log.message(checkLine(check.code, check.ok, check.details));
  }

  if (readiness.ok) {
    p.log.success('Worker is ready for workspace deploy testing');
    return;
  }

  p.log.warning('Worker is not fully ready for workspace deploy testing');
  p.log.message('Suggested bootstrap command: `pnpm run setup:worker`');
  throw new Error('Doctor checks failed');
}
