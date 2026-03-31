import * as p from '@clack/prompts';
import { createAdminApiKey } from '../../clients/worker/admin.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';

type Reporter = {
  success: (message: string) => void;
  warning: (message: string) => void;
  message: (message: string) => void;
};

const defaultReporter: Reporter = {
  success: (message) => p.log.success(message),
  warning: (message) => p.log.warning(message),
  message: (message) => p.log.message(message),
};

let createAdminApiKeyForCommand = createAdminApiKey;

export function setAdminProvisionCommandApiForTests(
  handler: typeof createAdminApiKey | null
): void {
  createAdminApiKeyForCommand = handler ?? createAdminApiKey;
}

export async function provisionAdminKeyCommand(
  input: {
    label?: string;
    accountId?: string;
    isAdmin?: boolean;
  },
  reporter: Reporter = defaultReporter
): Promise<void> {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) {
    throw new Error('Missing required --label. Usage: nimbus admin provision-key --label <string>');
  }

  const apiKey = typeof process.env.NIMBUS_API_KEY === 'string' ? process.env.NIMBUS_API_KEY.trim() : '';
  if (!apiKey) {
    throw new Error('NIMBUS_API_KEY is required to provision admin keys. Set it in your env or .env file.');
  }

  const workerUrl = getWorkerUrl();
  try {
    const created = await createAdminApiKeyForCommand(workerUrl, {
      label,
      accountId: typeof input.accountId === 'string' && input.accountId.trim() ? input.accountId.trim() : undefined,
      isAdmin: input.isAdmin === true,
    });

    reporter.success('Provisioned API key');
    reporter.warning('Save this key now. It will not be shown again.');
    reporter.message(`Key: ${created.key}`);
    reporter.message(`Account ID: ${created.accountId}`);
    reporter.message(`Label: ${created.label}`);
    reporter.message(`Admin: ${created.isAdmin ? 'true' : 'false'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Worker error (403)')) {
      throw new Error('Admin key provisioning forbidden (403). Ensure NIMBUS_API_KEY belongs to an admin account.');
    }
    throw error;
  }
}
