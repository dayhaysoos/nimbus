import { authExchangeCommand } from '../../commands/auth/exchange.js';
import { authHealthCommand } from '../../commands/auth/health.js';
import type { ParsedCliArgs } from '../../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchAuthCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
  const authAction = positional[0];
  if (authAction === 'exchange') {
    await authExchangeCommand({ json: Boolean(flags.json) });
    return;
  }
  if (authAction === 'health') {
    await authHealthCommand({ json: Boolean(flags.json) });
    return;
  }

  exitWithUsage('Unknown auth command. Use: exchange, health');
}
