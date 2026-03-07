#!/usr/bin/env node

import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env from repo root or current directory
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '..', '..', '.env'), // When run from packages/cli
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    break;
  }
}

import * as p from '@clack/prompts';
import { listCommand } from './commands/list.js';
import { watchCommand } from './commands/watch.js';
import { deployCheckpointCommand } from './commands/deploy/checkpoint.js';
import { resolveDeployCheckpointOptions } from './commands/deploy/checkpoint-options.js';
import { createWorkspaceCommand } from './commands/workspace/create.js';
import { showWorkspaceCommand } from './commands/workspace/show.js';
import { destroyWorkspaceCommand } from './commands/workspace/destroy.js';
import { listWorkspaceFilesCommand } from './commands/workspace/files.js';
import { catWorkspaceFileCommand } from './commands/workspace/cat.js';
import { workspaceDiffCommand } from './commands/workspace/diff.js';
import { parseArgs } from './lib/args.js';

const VERSION = '0.1.0';

function parsePositiveIntegerFlag(
  value: string | boolean | string[] | undefined
): number | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function showHelp(): void {
  console.log(`
nimbus - Entire checkpoint deployment CLI

Usage:
  nimbus <command> [options]

Commands:
  deploy checkpoint <checkpoint-id-or-commit-ish>
                      Resolve checkpoint/commit source and queue a deployment job
  workspace create <checkpoint-id-or-commit-ish>
                     Create a persistent sandbox workspace from checkpoint source
  workspace show <workspace-id>
                      Show workspace status and source metadata
  workspace destroy <workspace-id>
                      Destroy sandbox workspace and source bundle
  workspace files <workspace-id> [path]
                      List files in workspace at path (default: .)
  workspace cat <workspace-id> <path>
                      Read file content from workspace
  workspace diff <workspace-id>
                      Show workspace diff summary (use --include-patch for patch)
  list               List all past jobs
  watch <job-id>     Watch a job's progress

Options:
  --ref <ref>        Resolution hint for checkpoint lookup
  --project-root <path>
                     Deploy project root override for monorepos
  --env-file <path>  Extra env file(s), comma-separated
  --env KEY=VALUE    Explicit env override (repeatable)
  --no-tests         Skip tests in checkpoint deploy metadata
  --no-lint          Skip lint in checkpoint deploy metadata
  --no-watch         Disable follow-up watch guidance
  --include-patch    Include unified patch output for workspace diff
  --max-bytes <n>    Max bytes for diff/file output truncation
  --no-dry-run       Upload source bundle and create checkpoint job
  -h, --help         Show this help message
  -v, --version      Show version

Examples:
  nimbus deploy checkpoint checkpoint:8a513f56ed70
  nimbus workspace create checkpoint:8a513f56ed70 --project-root apps/web
  nimbus workspace show ws_abc12345
  nimbus workspace files ws_abc12345 src
  nimbus workspace diff ws_abc12345 --include-patch --max-bytes 262144
  nimbus deploy checkpoint main~1 --project-root apps/web --env API_URL=https://api.example.com
  nimbus list
  nimbus watch job_abc123

Environment Variables:
  NIMBUS_WORKER_URL  Worker URL (required) - Your self-hosted Nimbus worker

Self-hosting: https://github.com/dayhaysoos/nimbus#self-hosting-guide
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  try {
    const { command, flags, positional } = parseArgs(args);
    // Handle version flag
    if (flags.version || flags.v) {
      console.log(`nimbus v${VERSION}`);
      process.exit(0);
    }

    // Handle help flag
    if (flags.help || flags.h || !command) {
      showHelp();
      process.exit(command ? 0 : 1);
    }

    p.intro('@dayhaysoos/nimbus');

    switch (command) {
      case 'deploy': {
        const deployTarget = positional[0];
        const deployInput = positional[1];

        if (deployTarget !== 'checkpoint') {
          p.log.error('Missing or invalid deploy target. Usage: nimbus deploy checkpoint <checkpoint-id-or-commit-ish>');
          process.exit(1);
        }

        if (!deployInput) {
          p.log.error('Missing checkpoint ID or commit-ish. Usage: nimbus deploy checkpoint <checkpoint-id-or-commit-ish>');
          process.exit(1);
        }

        const deployOptions = resolveDeployCheckpointOptions(flags);
        await deployCheckpointCommand(deployInput, deployOptions);
        break;
      }

      case 'workspace': {
        const workspaceAction = positional[0];

        if (workspaceAction === 'create') {
          const input = positional[1];
          if (!input) {
            p.log.error(
              'Missing checkpoint ID or commit-ish. Usage: nimbus workspace create <checkpoint-id-or-commit-ish>'
            );
            process.exit(1);
          }

          const projectRootFlag = flags['project-root'];
          const refFlag = flags.ref;
          const projectRoot = typeof projectRootFlag === 'string' ? projectRootFlag : undefined;
          const ref = typeof refFlag === 'string' ? refFlag : undefined;
          await createWorkspaceCommand(input, { ref, projectRoot });
          break;
        }

        if (workspaceAction === 'show') {
          const workspaceId = positional[1];
          if (!workspaceId) {
            p.log.error('Missing workspace ID. Usage: nimbus workspace show <workspace-id>');
            process.exit(1);
          }

          await showWorkspaceCommand(workspaceId);
          break;
        }

        if (workspaceAction === 'destroy') {
          const workspaceId = positional[1];
          if (!workspaceId) {
            p.log.error('Missing workspace ID. Usage: nimbus workspace destroy <workspace-id>');
            process.exit(1);
          }

          await destroyWorkspaceCommand(workspaceId);
          break;
        }

        if (workspaceAction === 'files') {
          const workspaceId = positional[1];
          if (!workspaceId) {
            p.log.error('Missing workspace ID. Usage: nimbus workspace files <workspace-id> [path]');
            process.exit(1);
          }

          const path = positional[2];
          await listWorkspaceFilesCommand(workspaceId, path);
          break;
        }

        if (workspaceAction === 'cat') {
          const workspaceId = positional[1];
          const path = positional[2];
          if (!workspaceId || !path) {
            p.log.error('Usage: nimbus workspace cat <workspace-id> <path>');
            process.exit(1);
          }

          const maxBytes = parsePositiveIntegerFlag(flags['max-bytes']);

          await catWorkspaceFileCommand(workspaceId, path, maxBytes);
          break;
        }

        if (workspaceAction === 'diff') {
          const workspaceId = positional[1];
          if (!workspaceId) {
            p.log.error('Usage: nimbus workspace diff <workspace-id> [--include-patch] [--max-bytes <n>]');
            process.exit(1);
          }

          const includePatch = Boolean(flags['include-patch']);
          const maxBytes = parsePositiveIntegerFlag(flags['max-bytes']);

          await workspaceDiffCommand(workspaceId, { includePatch, maxBytes });
          break;
        }

        p.log.error('Unknown workspace command. Use: create, show, destroy, files, cat, diff');
        process.exit(1);
      }

      case 'list': {
        await listCommand();
        break;
      }

      case 'watch': {
        const jobId = positional[0];
        if (!jobId) {
          p.log.error('Missing job ID. Usage: nimbus watch <job-id>');
          process.exit(1);
        }
        await watchCommand(jobId);
        break;
      }

      default: {
        p.log.error(`Unknown command: ${command}`);
        p.log.info('Run "nimbus --help" for usage information.');
        process.exit(1);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

main();
