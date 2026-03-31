import { registerRepoCommand } from '../../commands/repo/register.js';
import type { ParsedCliArgs } from '../../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchRepoCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
  const repoAction = positional[0];
  if (repoAction === 'register') {
    const repoFlag = flags.repo;
    const repo = typeof repoFlag === 'string' ? repoFlag : undefined;
    await registerRepoCommand({ repo, dryRun: Boolean(flags['dry-run']), json: Boolean(flags.json) });
    return;
  }

  exitWithUsage('Unknown repo command. Use: register');
}
