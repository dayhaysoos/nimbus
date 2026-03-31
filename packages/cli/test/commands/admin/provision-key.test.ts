import { strict as assert } from 'assert';
import { provisionAdminKeyCommand, setAdminProvisionCommandApiForTests } from '../../../src/commands/admin/provision-key.js';

type CapturedLog = {
  success: string[];
  warning: string[];
  message: string[];
};

function createReporter(captured: CapturedLog): {
  success: (message: string) => void;
  warning: (message: string) => void;
  message: (message: string) => void;
} {
  return {
    success: (message) => captured.success.push(message),
    warning: (message) => captured.warning.push(message),
    message: (message) => captured.message.push(message),
  };
}

export async function runAdminProvisionKeyCommandTests(): Promise<void> {
  const originalNimbusApiKey = process.env.NIMBUS_API_KEY;

  try {
    {
      process.env.NIMBUS_API_KEY = 'nmb_live_admin';
      await assert.rejects(
        () => provisionAdminKeyCommand({ label: '   ' }),
        /Missing required --label/
      );
    }

    {
      process.env.NIMBUS_API_KEY = 'nmb_live_admin';
      const captured: CapturedLog = { success: [], warning: [], message: [] };
      const issuedTestKey = 'nmb_live_test_key_for_cli_output';
      setAdminProvisionCommandApiForTests(async () => ({
        key: issuedTestKey,
        accountId: 'acct_beta',
        label: 'Beta User Key',
        isAdmin: false,
      }));

      await provisionAdminKeyCommand({ label: 'Beta User Key' }, createReporter(captured));

      assert.equal(captured.success.some((line) => line.includes('Provisioned API key')), true);
      assert.equal(captured.warning.some((line) => line.includes('will not be shown again')), true);
      assert.equal(
        captured.message.some((line) => line.includes(issuedTestKey)),
        true
      );
    }
  } finally {
    setAdminProvisionCommandApiForTests(null);
    if (originalNimbusApiKey === undefined) {
      delete process.env.NIMBUS_API_KEY;
    } else {
      process.env.NIMBUS_API_KEY = originalNimbusApiKey;
    }
  }
}
