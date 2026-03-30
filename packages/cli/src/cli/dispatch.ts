import * as p from '@clack/prompts';
import { provisionAdminKeyCommand } from '../commands/admin/provision-key.js';
import { deployCheckpointCommand } from '../commands/deploy/checkpoint.js';
import { resolveDeployCheckpointOptions } from '../commands/deploy/checkpoint-options.js';
import { doctorCommand } from '../commands/doctor.js';
import { registerRepoCommand } from '../commands/repo/register.js';
import { createReviewCommand, createReviewFromCommitCommand } from '../commands/review/create.js';
import { reviewEventsCommand } from '../commands/review/events.js';
import { exportReviewCommand } from '../commands/review/export.js';
import { openReviewFromCommitCommand, startReviewUiCommand } from '../commands/review/open.js';
import { reviewPolicyCommand } from '../commands/review/policy.js';
import { reviewPreflightCommand } from '../commands/review/preflight.js';
import { showReviewCommand } from '../commands/review/show.js';
import { createWorkspaceCommand } from '../commands/workspace/create.js';
import { catWorkspaceFileCommand } from '../commands/workspace/cat.js';
import { workspaceDiffCommand } from '../commands/workspace/diff.js';
import { workspaceDeployCommand } from '../commands/workspace/deploy.js';
import { destroyWorkspaceCommand } from '../commands/workspace/destroy.js';
import { listWorkspaceFilesCommand } from '../commands/workspace/files.js';
import { showWorkspaceCommand } from '../commands/workspace/show.js';
import { listCommand } from '../commands/list.js';
import { watchCommand } from '../commands/watch.js';
import { dispatchAuthCommand } from './dispatch/auth.js';
import type { ParsedCliArgs } from '../lib/args.js';
import { parseReviewMaxFindings, parseReviewSeverityThreshold } from '../lib/review-policy.js';
import { parsePositiveIntegerFlag } from './argv.js';

type CliFlags = ParsedCliArgs['flags'];

function exitWithUsage(message: string): never {
  p.log.error(message);
  process.exit(1);
}

function parseSummarizeSessionFlag(flags: CliFlags): 'auto' | 'always' | 'never' | undefined {
  const summarizeSessionFlag = flags['summarize-session'];
  if (typeof summarizeSessionFlag !== 'string') {
    return undefined;
  }
  if (summarizeSessionFlag === 'auto' || summarizeSessionFlag === 'always' || summarizeSessionFlag === 'never') {
    return summarizeSessionFlag;
  }
  throw new Error('Invalid --summarize-session value. Use auto, always, or never.');
}

function parseDeployProviderFlag(flags: CliFlags): 'simulated' | 'cloudflare_workers_assets' | undefined {
  const providerFlag = flags.provider;
  if (typeof providerFlag !== 'string') {
    return undefined;
  }
  if (providerFlag === 'simulated' || providerFlag === 'cloudflare_workers_assets') {
    return providerFlag;
  }
  throw new Error('Invalid --provider value. Use simulated or cloudflare_workers_assets.');
}

async function handleWorkspaceCommand(positional: string[], flags: CliFlags): Promise<void> {
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

async function handleReviewCommand(positional: string[], flags: CliFlags): Promise<void> {
  const reviewAction = positional[0];

  if (reviewAction === 'create') {
    const workspaceFlag = flags.workspace;
    const deploymentFlag = flags.deployment;
    const commitFlag = flags.commit;
    const workspaceId = typeof workspaceFlag === 'string' ? workspaceFlag : undefined;
    const deploymentId = typeof deploymentFlag === 'string' ? deploymentFlag : undefined;
    const idempotencyKeyFlag = flags['idempotency-key'];
    const idempotencyKey = typeof idempotencyKeyFlag === 'string' ? idempotencyKeyFlag : undefined;
    const modelFlag = flags.model;
    const model = typeof modelFlag === 'string' && modelFlag.trim() ? modelFlag.trim() : undefined;
    const intentSummaryModelFlag = flags['intent-summary-model'];
    const intentSummaryModel =
      typeof intentSummaryModelFlag === 'string' && intentSummaryModelFlag.trim()
        ? intentSummaryModelFlag.trim()
        : undefined;
    const projectRootFlag = flags['project-root'];
    const projectRoot = typeof projectRootFlag === 'string' && projectRootFlag.trim() ? projectRootFlag.trim() : undefined;
    const baseFlag = flags.base;
    const baseRef = typeof baseFlag === 'string' && baseFlag.trim() ? baseFlag.trim() : undefined;
    const outputReviewIdFlag = flags['output-review-id'];
    const outputReviewIdPath =
      typeof outputReviewIdFlag === 'string' && outputReviewIdFlag.trim() ? outputReviewIdFlag.trim() : undefined;
    const outputReviewIdPathForCommand = outputReviewIdFlag === true ? '' : outputReviewIdPath;
    const severityThreshold = parseReviewSeverityThreshold(flags['severity-threshold']);
    const maxFindings = parseReviewMaxFindings(flags['max-findings']);
    const commitModeRequested = typeof commitFlag === 'string' || commitFlag === true;
    const hasWorkspaceInputs = Boolean(workspaceId || deploymentId);
    const unexpectedPositional = positional[1];

    if (typeof unexpectedPositional === 'string' && unexpectedPositional.trim()) {
      exitWithUsage('Usage error: review create does not accept positional arguments. Use --commit or --workspace/--deployment flags.');
    }

    if (commitModeRequested && hasWorkspaceInputs) {
      exitWithUsage('Usage error: --commit cannot be combined with --workspace/--deployment. Choose one review create mode.');
    }

    if (commitModeRequested || (!workspaceId && !deploymentId)) {
      if (!commitModeRequested && !workspaceId && !deploymentId) {
        p.log.message('No review target flags provided; defaulting to `nimbus review create --commit HEAD`.');
      }
      await createReviewFromCommitCommand({
        commitish: typeof commitFlag === 'string' ? commitFlag : 'HEAD',
        baseRef,
        outputReviewIdPath: outputReviewIdPathForCommand,
        projectRoot,
        idempotencyKey,
        severityThreshold,
        maxFindings,
        model,
        intentSummaryModel,
        includeProvenance: !Boolean(flags['no-provenance']),
        includeValidationEvidence: !Boolean(flags['no-validation-evidence']),
        pollIntervalMs: parsePositiveIntegerFlag(flags['poll-interval-ms']),
      });
      return;
    }

    if (!workspaceId || !deploymentId) {
      exitWithUsage('Usage: nimbus review create --commit [commit-ish] OR --workspace <workspace-id> --deployment <deployment-id>');
    }

    await createReviewCommand(workspaceId, deploymentId, {
      idempotencyKey,
      severityThreshold,
      maxFindings,
      model,
      intentSummaryModel,
      includeProvenance: !Boolean(flags['no-provenance']),
      includeValidationEvidence: !Boolean(flags['no-validation-evidence']),
    });
    return;
  }

  if (reviewAction === 'show') {
    const reviewId = positional[1];
    if (!reviewId) {
      exitWithUsage('Usage: nimbus review show <review-id>');
    }

    await showReviewCommand(reviewId);
    return;
  }

  if (reviewAction === 'preflight') {
    const commitishArg = positional[1];
    const baseFlag = flags.base;
    const baseRef = typeof baseFlag === 'string' && baseFlag.trim() ? baseFlag.trim() : undefined;
    await reviewPreflightCommand(typeof commitishArg === 'string' ? commitishArg : 'HEAD', {
      baseRef,
      strictEntireContext: Boolean(flags['strict-entire-context']),
      summarizeSession: parseSummarizeSessionFlag(flags),
      intentTokenBudget: parsePositiveIntegerFlag(flags['intent-token-budget']),
    });
    return;
  }

  if (reviewAction === 'policy') {
    const commitFlag = flags.commit;
    const commitishArg = positional[1];
    const commitish =
      typeof commitFlag === 'string' && commitFlag.trim()
        ? commitFlag.trim()
        : typeof commitishArg === 'string' && commitishArg.trim()
          ? commitishArg.trim()
          : 'HEAD';
    const baseFlag = flags.base;
    const baseRef = typeof baseFlag === 'string' && baseFlag.trim() ? baseFlag.trim() : undefined;
    const modelFlag = flags.model;
    const model = typeof modelFlag === 'string' && modelFlag.trim() ? modelFlag.trim() : undefined;
    await reviewPolicyCommand({
      commitish,
      baseRef,
      model,
      json: Boolean(flags.json),
    });
    return;
  }

  if (reviewAction === 'events') {
    const reviewId = positional[1];
    if (!reviewId) {
      exitWithUsage('Usage: nimbus review events <review-id>');
    }

    await reviewEventsCommand(reviewId);
    return;
  }

  if (reviewAction === 'export') {
    const reviewId = positional[1];
    const formatFlag = flags.format;
    const outFlag = flags.out;
    const format = typeof formatFlag === 'string' ? formatFlag : 'markdown';
    const outputPath = typeof outFlag === 'string' ? outFlag : undefined;
    if (!reviewId || !outputPath) {
      exitWithUsage('Usage: nimbus review export <review-id> --format <markdown|json> --out <path>');
    }
    if (format !== 'markdown' && format !== 'json') {
      exitWithUsage('Invalid --format value. Use markdown or json.');
    }

    await exportReviewCommand(reviewId, format, outputPath);
    return;
  }

  if (reviewAction === 'open') {
    const unexpectedPositional = positional[1];
    if (typeof unexpectedPositional === 'string' && unexpectedPositional.trim()) {
      exitWithUsage('Usage: nimbus review open [--commit <commit-ish>] [--port <n>] [--base <ref>] [--project-root <path>]');
    }

    const workspaceFlag = flags.workspace;
    const deploymentFlag = flags.deployment;
    if (typeof workspaceFlag === 'string' || typeof deploymentFlag === 'string') {
      exitWithUsage('review open no longer accepts --workspace/--deployment. It now resolves workspace and deployment automatically from git context.');
    }

    const port = parsePositiveIntegerFlag(flags.port);
    const commitFlag = flags.commit;
    const commitish = typeof commitFlag === 'string' ? commitFlag : commitFlag === true ? 'HEAD' : 'HEAD';
    const baseFlag = flags.base;
    const baseRef = typeof baseFlag === 'string' && baseFlag.trim() ? baseFlag.trim() : undefined;
    const projectRootFlag = flags['project-root'];
    const projectRoot = typeof projectRootFlag === 'string' && projectRootFlag.trim() ? projectRootFlag.trim() : undefined;
    const idempotencyKeyFlag = flags['idempotency-key'];
    const idempotencyKey = typeof idempotencyKeyFlag === 'string' && idempotencyKeyFlag.trim() ? idempotencyKeyFlag.trim() : undefined;

    await openReviewFromCommitCommand({
      port,
      commitish,
      baseRef,
      projectRoot,
      idempotencyKey,
      pollIntervalMs: parsePositiveIntegerFlag(flags['poll-interval-ms']),
    });
    return;
  }

  if (reviewAction === 'start') {
    const unexpectedPositional = positional[1];
    if (typeof unexpectedPositional === 'string' && unexpectedPositional.trim()) {
      exitWithUsage('Usage: nimbus review start [--port <n>]');
    }

    await startReviewUiCommand({
      port: parsePositiveIntegerFlag(flags.port),
    });
    return;
  }

  exitWithUsage('Unknown review command. Use: create, preflight, policy, show, events, start, open, export');
}

async function handleAdminCommand(positional: string[], flags: CliFlags): Promise<void> {
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

async function handleRepoCommand(positional: string[], flags: CliFlags): Promise<void> {
  const repoAction = positional[0];
  if (repoAction === 'register') {
    const repoFlag = flags.repo;
    const repo = typeof repoFlag === 'string' ? repoFlag : undefined;
    await registerRepoCommand({ repo, dryRun: Boolean(flags['dry-run']), json: Boolean(flags.json) });
    return;
  }

  exitWithUsage('Unknown repo command. Use: register');
}

export async function dispatchCliCommand({ command, flags, positional }: ParsedCliArgs): Promise<void> {
  switch (command) {
    case 'doctor': {
      await doctorCommand();
      return;
    }

    case 'deploy': {
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
      return;
    }

    case 'workspace': {
      await handleWorkspaceCommand(positional, flags);
      return;
    }

    case 'review': {
      await handleReviewCommand(positional, flags);
      return;
    }

    case 'admin': {
      await handleAdminCommand(positional, flags);
      return;
    }

    case 'repo': {
      await handleRepoCommand(positional, flags);
      return;
    }

    case 'auth': {
      await dispatchAuthCommand(positional, flags, exitWithUsage);
      return;
    }

    case 'list': {
      await listCommand();
      return;
    }

    case 'watch': {
      const jobId = positional[0];
      if (!jobId) {
        exitWithUsage('Missing job ID. Usage: nimbus watch <job-id>');
      }
      await watchCommand(jobId);
      return;
    }

    default: {
      p.log.error(`Unknown command: ${command}`);
      p.log.info('Run "nimbus --help" for usage information.');
      process.exit(1);
    }
  }
}
