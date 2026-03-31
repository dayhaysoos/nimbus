import { deployCheckpointCommand } from '../../commands/deploy/checkpoint.js';
import { resolveDeployCheckpointOptions } from '../../commands/deploy/checkpoint-options.js';
import type { ParsedCliArgs } from '../../lib/args.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchDeployCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
  const deployTarget = positional[0];
  const deployInput = positional[1];

  if (deployTarget !== 'checkpoint') {
    exitWithUsage('Missing or invalid deploy target. Usage: nimbus deploy checkpoint <checkpoint-id-or-commit-ish>');
  }

  if (!deployInput) {
    exitWithUsage('Missing checkpoint ID or commit-ish. Usage: nimbus deploy checkpoint <checkpoint-id-or-commit-ish>');
  }

  const deployOptions = resolveDeployCheckpointOptions(flags);
  await deployCheckpointCommand(deployInput, deployOptions);
}
