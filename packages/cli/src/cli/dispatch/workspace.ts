import { createWorkspaceCommand } from '../../commands/workspace/create.js';
import { catWorkspaceFileCommand } from '../../commands/workspace/cat.js';
import { workspaceDiffCommand } from '../../commands/workspace/diff.js';
import { workspaceDeployCommand } from '../../commands/workspace/deploy.js';
import { destroyWorkspaceCommand } from '../../commands/workspace/destroy.js';
import { listWorkspaceFilesCommand } from '../../commands/workspace/files.js';
import { showWorkspaceCommand } from '../../commands/workspace/show.js';
import type { ParsedCliArgs } from '../../lib/args.js';
import { parsePositiveIntegerFlag } from '../argv.js';
import { parseDeployProviderFlag, parseSummarizeSessionFlag } from './flags.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchWorkspaceCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
  const workspaceAction = positional[0];

  if (workspaceAction === 'create') {
    const input = positional[1];
    if (!input) {
      exitWithUsage('Missing checkpoint ID or commit-ish. Usage: nimbus workspace create <checkpoint-id-or-commit-ish>');
    }

    const projectRootFlag = flags['project-root'];
    const refFlag = flags.ref;
    const projectRoot = typeof projectRootFlag === 'string' ? projectRootFlag : undefined;
    const ref = typeof refFlag === 'string' ? refFlag : undefined;
    await createWorkspaceCommand(input, { ref, projectRoot });
    return;
  }

  if (workspaceAction === 'show') {
    const workspaceId = positional[1];
    if (!workspaceId) {
      exitWithUsage('Missing workspace ID. Usage: nimbus workspace show <workspace-id>');
    }

    await showWorkspaceCommand(workspaceId);
    return;
  }

  if (workspaceAction === 'destroy') {
    const workspaceId = positional[1];
    if (!workspaceId) {
      exitWithUsage('Missing workspace ID. Usage: nimbus workspace destroy <workspace-id>');
    }

    await destroyWorkspaceCommand(workspaceId);
    return;
  }

  if (workspaceAction === 'files') {
    const workspaceId = positional[1];
    if (!workspaceId) {
      exitWithUsage('Missing workspace ID. Usage: nimbus workspace files <workspace-id> [path]');
    }

    const path = positional[2];
    await listWorkspaceFilesCommand(workspaceId, path);
    return;
  }

  if (workspaceAction === 'cat') {
    const workspaceId = positional[1];
    const path = positional[2];
    if (!workspaceId || !path) {
      exitWithUsage('Usage: nimbus workspace cat <workspace-id> <path>');
    }

    const maxBytes = parsePositiveIntegerFlag(flags['max-bytes']);
    await catWorkspaceFileCommand(workspaceId, path, maxBytes);
    return;
  }

  if (workspaceAction === 'diff') {
    const workspaceId = positional[1];
    if (!workspaceId) {
      exitWithUsage('Usage: nimbus workspace diff <workspace-id> [--include-patch] [--max-bytes <n>]');
    }

    const includePatch = Boolean(flags['include-patch']);
    const maxBytes = parsePositiveIntegerFlag(flags['max-bytes']);
    await workspaceDiffCommand(workspaceId, { includePatch, maxBytes });
    return;
  }

  if (workspaceAction === 'deploy') {
    const workspaceId = positional[1];
    if (!workspaceId) {
      exitWithUsage('Usage: nimbus workspace deploy <workspace-id>');
    }

    const idempotencyKeyFlag = flags['idempotency-key'];
    const idempotencyKey = typeof idempotencyKeyFlag === 'string' ? idempotencyKeyFlag : undefined;
    const pollIntervalMs = parsePositiveIntegerFlag(flags['poll-interval-ms']);
    const runTestsIfPresent = Boolean(flags.tests) && !Boolean(flags['no-tests']);
    const runBuildIfPresent = Boolean(flags.build) && !Boolean(flags['no-build']);
    const preflightOnly = Boolean(flags['preflight-only']);
    const autoFix = Boolean(flags['auto-fix']);
    const provider = parseDeployProviderFlag(flags);
    const outputDirFlag = flags['output-dir'];
    const outputDir = typeof outputDirFlag === 'string' ? outputDirFlag : undefined;
    const summarizeSession = parseSummarizeSessionFlag(flags);
    const intentTokenBudget = parsePositiveIntegerFlag(flags['intent-token-budget']);

    await workspaceDeployCommand(workspaceId, {
      idempotencyKey,
      runTestsIfPresent,
      runBuildIfPresent,
      preflightOnly,
      autoFix,
      pollIntervalMs,
      provider,
      outputDir,
      summarizeSession,
      intentTokenBudget,
    });
    return;
  }

  exitWithUsage('Unknown workspace command. Use: create, show, destroy, files, cat, diff, deploy');
}
