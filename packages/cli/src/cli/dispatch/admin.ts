import { provisionAdminKeyCommand } from '../../commands/admin/provision-key.js';
import type { ParsedCliArgs } from '../../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchAdminCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
  const adminAction = positional[0];
  if (adminAction === 'provision-key') {
    const labelFlag = flags.label;
    const accountIdFlag = flags['account-id'];
    const label = typeof labelFlag === 'string' ? labelFlag : '';
    const accountId = typeof accountIdFlag === 'string' ? accountIdFlag : undefined;

    await provisionAdminKeyCommand({
      label,
      accountId,
      isAdmin: Boolean(flags.admin),
    });
    return;
  }

  exitWithUsage('Unknown admin command. Use: provision-key');
}
