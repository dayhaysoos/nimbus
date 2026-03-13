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
import { createReviewCommand } from './commands/review/create.js';
import { reviewEventsCommand } from './commands/review/events.js';
import { showReviewCommand } from './commands/review/show.js';
import { exportReviewCommand } from './commands/review/export.js';
import { parseArgs } from './lib/args.js';
import { parseReviewMaxFindings, parseReviewSeverityThreshold } from './lib/review-policy.js';

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
  review create --workspace <id> --deployment <id>
                      Create a report-only review run for a deployment
  review show <review-id>
                      Show review status and summary
  review events <review-id>
                      Stream review lifecycle events
  review export <review-id>
                      Export a review as markdown or json
  list               List all past jobs
  watch <job-id>     Watch a job's progress

Options:
  --ref <ref>        Resolution hint for checkpoint lookup
  --project-root <path>
                     Deploy project root override for monorepos
  --env-file <path>  Extra env file(s), comma-separated
  --env KEY=VALUE    Explicit env override (repeatable)
  --tests            Run tests during workspace deploy validation (default: off)
  --build            Run build during workspace deploy validation (default: off)
  --no-tests         Legacy alias to disable tests explicitly
  --no-build         Legacy alias to disable build explicitly
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
  --summarize-session <mode>
                      Intent context summarization mode (auto|always|never)
  --intent-token-budget <n>
                      Token budget for Entire intent context capture (default: 1200)
  --workspace <id>    Workspace ID for review create
  --deployment <id>   Deployment ID for review create
  --severity-threshold <level>
                      Review finding floor (low|medium|high|critical)
  --max-findings <n>  Maximum findings to include in report
  --no-provenance     Suppress provenance summary in report output
  --no-validation-evidence
                      Suppress validation/deploy evidence in report output
  --format <type>     Review export format (markdown|json)
  --out <path>        Review export output file path
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
  nimbus workspace deploy ws_abc12345 --preflight-only
  nimbus workspace deploy ws_abc12345 --tests --build
  nimbus review create --workspace ws_abc12345 --deployment dep_abcd1234
  nimbus review create --workspace ws_abc12345 --deployment dep_abcd1234 --severity-threshold medium --max-findings 20
  nimbus review show rev_abcd1234
  nimbus review events rev_abcd1234
  nimbus review export rev_abcd1234 --format markdown --out review.md
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
          const runTestsIfPresent = Boolean(flags.tests) && !Boolean(flags['no-tests']);
          const runBuildIfPresent = Boolean(flags.build) && !Boolean(flags['no-build']);
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
          const summarizeSessionFlag = flags['summarize-session'];
          let summarizeSession: 'auto' | 'always' | 'never' | undefined;
          if (typeof summarizeSessionFlag === 'string') {
            if (summarizeSessionFlag === 'auto' || summarizeSessionFlag === 'always' || summarizeSessionFlag === 'never') {
              summarizeSession = summarizeSessionFlag;
            } else {
              throw new Error('Invalid --summarize-session value. Use auto, always, or never.');
            }
          }
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
          break;
        }

        p.log.error('Unknown workspace command. Use: create, show, destroy, files, cat, diff, deploy');
        process.exit(1);
      }

      case 'review': {
        const reviewAction = positional[0];

        if (reviewAction === 'create') {
          const workspaceFlag = flags.workspace;
          const deploymentFlag = flags.deployment;
          const workspaceId = typeof workspaceFlag === 'string' ? workspaceFlag : undefined;
          const deploymentId = typeof deploymentFlag === 'string' ? deploymentFlag : undefined;
          if (!workspaceId || !deploymentId) {
            p.log.error('Usage: nimbus review create --workspace <workspace-id> --deployment <deployment-id>');
            process.exit(1);
          }

          const idempotencyKeyFlag = flags['idempotency-key'];
          const idempotencyKey = typeof idempotencyKeyFlag === 'string' ? idempotencyKeyFlag : undefined;
          const severityThreshold = parseReviewSeverityThreshold(flags['severity-threshold']);
          const maxFindings = parseReviewMaxFindings(flags['max-findings']);
          await createReviewCommand(workspaceId, deploymentId, {
            idempotencyKey,
            severityThreshold,
            maxFindings,
            includeProvenance: !Boolean(flags['no-provenance']),
            includeValidationEvidence: !Boolean(flags['no-validation-evidence']),
          });
          break;
        }

        if (reviewAction === 'show') {
          const reviewId = positional[1];
          if (!reviewId) {
            p.log.error('Usage: nimbus review show <review-id>');
            process.exit(1);
          }

          await showReviewCommand(reviewId);
          break;
        }

        if (reviewAction === 'events') {
          const reviewId = positional[1];
          if (!reviewId) {
            p.log.error('Usage: nimbus review events <review-id>');
            process.exit(1);
          }

          await reviewEventsCommand(reviewId);
          break;
        }

        if (reviewAction === 'export') {
          const reviewId = positional[1];
          const formatFlag = flags.format;
          const outFlag = flags.out;
          const format = typeof formatFlag === 'string' ? formatFlag : 'markdown';
          const outputPath = typeof outFlag === 'string' ? outFlag : undefined;
          if (!reviewId || !outputPath) {
            p.log.error('Usage: nimbus review export <review-id> --format <markdown|json> --out <path>');
            process.exit(1);
          }
          if (format !== 'markdown' && format !== 'json') {
            p.log.error('Invalid --format value. Use markdown or json.');
            process.exit(1);
          }

          await exportReviewCommand(reviewId, format, outputPath);
          break;
        }

        p.log.error('Unknown review command. Use: create, show, events, export');
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
