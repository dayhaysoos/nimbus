import * as p from '@clack/prompts';
import { createReviewCommand, createReviewFromCommitCommand } from '../../commands/review/create.js';
import { reviewEventsCommand } from '../../commands/review/events.js';
import { exportReviewCommand } from '../../commands/review/export.js';
import { openReviewFromCommitCommand, startReviewUiCommand } from '../../commands/review/open.js';
import { reviewPolicyCommand } from '../../commands/review/policy.js';
import { reviewPreflightCommand } from '../../commands/review/preflight.js';
import { showReviewCommand } from '../../commands/review/show.js';
import type { ParsedCliArgs } from '../../lib/args.js';
import { parseReviewMaxFindings, parseReviewSeverityThreshold } from '../../lib/review-policy.js';
import { parsePositiveIntegerFlag } from '../argv.js';
import { parseSummarizeSessionFlag } from './flags.js';

type CliFlags = ParsedCliArgs['flags'];

export async function dispatchReviewCommand(
  positional: string[],
  flags: CliFlags,
  exitWithUsage: (message: string) => never,
): Promise<void> {
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
