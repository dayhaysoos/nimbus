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
import { workspaceDeployCommand } from './commands/workspace/deploy.js';
import { doctorCommand } from './commands/doctor.js';
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

function normalizeCliToken(token: string): { value: string; changed: boolean } {
  let value = token;
  value = value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  if (/^[\u2013\u2014]/.test(value)) {
    value = `--${value.slice(1)}`;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { value, changed: value !== token };
}

function normalizeCliArgs(rawArgs: string[]): { args: string[]; changed: boolean } {
  const normalized: string[] = [];
  let changed = false;
  for (const token of rawArgs) {
    const next = normalizeCliToken(token);
    normalized.push(next.value);
    if (next.changed) {
      changed = true;
    }
  }
  return { args: normalized, changed };
}

function showHelp(): void {
  console.log(`
nimbus - Entire checkpoint deployment CLI

Usage:
  nimbus <command> [options]

Commands:
  doctor             Validate worker deploy readiness and migrations
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
  workspace deploy <workspace-id>
                      Run deploy preflight, queue deploy, and poll status
  list               List all past jobs
  watch <job-id>     Watch a job's progress

Options:
  --ref <ref>        Resolution hint for checkpoint lookup
  --project-root <path>
                     Deploy project root override for monorepos
  --env-file <path>  Extra env file(s), comma-separated
  --env KEY=VALUE    Explicit env override (repeatable)
  --no-tests         Skip tests in checkpoint deploy metadata
  --no-build         Skip build in workspace deploy metadata
  --no-lint          Skip lint in checkpoint deploy metadata
  --no-watch         Disable follow-up watch guidance
  --include-patch    Include unified patch output for workspace diff
  --max-bytes <n>    Max bytes for diff/file output truncation
  --idempotency-key <key>
                     Stable idempotency key for workspace deploy retries
  --poll-interval-ms <n>
                      Poll interval for workspace deploy status checks
  --provider <name>   Deploy provider (simulated|cloudflare_workers_assets)
  --output-dir <path> Static build output directory (required for real provider)
  --preflight-only   Run deploy preflight only (do not queue deploy)
  --auto-fix         Allow safe preflight/deploy remediations
  --no-dry-run       Upload source bundle and create checkpoint job
  -h, --help         Show this help message
  -v, --version      Show version

Examples:
  nimbus deploy checkpoint checkpoint:8a513f56ed70
  nimbus workspace create checkpoint:8a513f56ed70 --project-root apps/web
  nimbus workspace show ws_abc12345
  nimbus workspace files ws_abc12345 src
  nimbus workspace diff ws_abc12345 --include-patch --max-bytes 262144
  nimbus workspace deploy ws_abc12345
  nimbus workspace deploy ws_abc12345 --provider cloudflare_workers_assets --output-dir dist
  nimbus workspace deploy ws_abc12345 --idempotency-key deploy-smoke-123 --auto-fix
  nimbus workspace deploy ws_abc12345 --preflight-only --no-tests --no-build
  nimbus doctor
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
    const normalized = normalizeCliArgs(args);
    try {
    const { command, flags, positional } = parseArgs(normalized.args);
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

    if (normalized.changed) {
      p.log.warning('Detected smart punctuation in arguments; normalized to ASCII equivalents.');
    }

    switch (command) {
      case 'doctor': {
        await doctorCommand();
        break;
      }

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

        if (workspaceAction === 'deploy') {
          const workspaceId = positional[1];
          if (!workspaceId) {
            p.log.error('Usage: nimbus workspace deploy <workspace-id>');
            process.exit(1);
          }

          const idempotencyKeyFlag = flags['idempotency-key'];
          const idempotencyKey = typeof idempotencyKeyFlag === 'string' ? idempotencyKeyFlag : undefined;
          const pollIntervalMs = parsePositiveIntegerFlag(flags['poll-interval-ms']);
          const runTestsIfPresent = !flags['no-tests'];
          const runBuildIfPresent = !flags['no-build'];
          const preflightOnly = Boolean(flags['preflight-only']);
          const autoFix = Boolean(flags['auto-fix']);
          const providerFlag = flags.provider;
          let provider: 'simulated' | 'cloudflare_workers_assets' | undefined;
          if (typeof providerFlag === 'string') {
            if (providerFlag === 'simulated' || providerFlag === 'cloudflare_workers_assets') {
              provider = providerFlag;
            } else {
              throw new Error('Invalid --provider value. Use simulated or cloudflare_workers_assets.');
            }
          }
          const outputDirFlag = flags['output-dir'];
          const outputDir = typeof outputDirFlag === 'string' ? outputDirFlag : undefined;

          await workspaceDeployCommand(workspaceId, {
            idempotencyKey,
            runTestsIfPresent,
            runBuildIfPresent,
            preflightOnly,
            autoFix,
            pollIntervalMs,
            provider,
            outputDir,
          });
          break;
        }

        p.log.error('Unknown workspace command. Use: create, show, destroy, files, cat, diff, deploy');
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
