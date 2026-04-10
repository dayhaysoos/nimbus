import * as p from '@clack/prompts';
import { createReviewCommand, createReviewFromCommitCommand } from '../../commands/review/create.js';
import { reviewEventsCommand } from '../../commands/review/events.js';
import { exportReviewCommand } from '../../commands/review/export.js';
import { openReviewFromCommitCommand, startReviewStudioCommand } from '../../commands/review/open.js';
import { reviewPolicyCommand } from '../../commands/review/policy.js';
import { reviewPreflightCommand } from '../../commands/review/preflight.js';
import { showReviewCommand } from '../../commands/review/show.js';
import type { ParsedCliArgs } from '../../lib/args.js';
import { parseReviewMaxFindings, parseReviewSeverityThreshold } from '../../lib/review-policy.js';
import { parsePositiveIntegerFlag } from '../argv.js';
import { parseSummarizeSessionFlag } from './flags.js';

type CliFlags = ParsedCliArgs['flags'];
type ReviewPolicyMode = 'none' | 'auto' | 'review';

function normalizePolicyMode(raw: string | undefined): ReviewPolicyMode | null {
  if (raw === 'none' || raw === 'auto' || raw === 'review') {
    return raw;
  }
  return null;
}

function resolvePolicyMode(flags: CliFlags, exitWithUsage: (message: string) => never): ReviewPolicyMode {
  const policyModeFlag = flags['policy-mode'];
  const canonicalPolicyMode =
    typeof policyModeFlag === 'string' && policyModeFlag.trim() ? normalizePolicyMode(policyModeFlag.trim()) : null;
  if (typeof policyModeFlag === 'string' && policyModeFlag.trim() && !canonicalPolicyMode) {
    exitWithUsage('Invalid --policy-mode value. Use one of: none, auto, review.');
  }

  const autoPolicy = Boolean(flags['auto-policy']);
  const reviewPolicy = Boolean(flags.policy);
  if (autoPolicy && reviewPolicy) {
    exitWithUsage('Usage error: --auto-policy and --policy cannot be used together.');
  }

  if (canonicalPolicyMode && autoPolicy && canonicalPolicyMode !== 'auto') {
    exitWithUsage('Usage error: --policy-mode conflicts with --auto-policy.');
  }
  if (canonicalPolicyMode && reviewPolicy && canonicalPolicyMode !== 'review') {
    exitWithUsage('Usage error: --policy-mode conflicts with --policy.');
  }

  if (canonicalPolicyMode) {
    return canonicalPolicyMode;
  }
  if (autoPolicy) {
    return 'auto';
  }
  if (reviewPolicy) {
    return 'review';
  }
  return 'none';
}

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
    const checkpointRangeFlag = flags['checkpoint-range'];
    const checkpointRange =
      typeof checkpointRangeFlag === 'string' && checkpointRangeFlag.trim() ? checkpointRangeFlag.trim() : undefined;
    const lastCheckpoints = parsePositiveIntegerFlag(flags['last-checkpoints']);
    if (typeof lastCheckpoints === 'number' && lastCheckpoints > 3) {
      exitWithUsage('Usage error: --last-checkpoints supports up to 3 in v1.');
    }
    const outputReviewIdFlag = flags['output-review-id'];
    const outputReviewIdPath =
      typeof outputReviewIdFlag === 'string' && outputReviewIdFlag.trim() ? outputReviewIdFlag.trim() : undefined;
    const outputReviewIdPathForCommand = outputReviewIdFlag === true ? '' : outputReviewIdPath;
    const severityThreshold = parseReviewSeverityThreshold(flags['severity-threshold']);
    const maxFindings = parseReviewMaxFindings(flags['max-findings']);
    const policyMode = resolvePolicyMode(flags, exitWithUsage);
    const openStudio = Boolean(flags['open-studio']);
    const openStudioPort = parsePositiveIntegerFlag(flags.port);
    const commitModeRequested = typeof commitFlag === 'string' || commitFlag === true;
    const hasWorkspaceInputs = Boolean(workspaceId || deploymentId);
    const unexpectedPositional = positional[1];

    if (typeof unexpectedPositional === 'string' && unexpectedPositional.trim()) {
      exitWithUsage('Usage error: review create does not accept positional arguments. Use --commit or --workspace/--deployment flags.');
    }

    if (commitModeRequested && hasWorkspaceInputs) {
      exitWithUsage('Usage error: --commit cannot be combined with --workspace/--deployment. Choose one review create mode.');
    }

    if (hasWorkspaceInputs && (checkpointRange || lastCheckpoints)) {
      exitWithUsage('Usage error: --last-checkpoints/--checkpoint-range can only be used with commit-based review create.');
    }

    if (baseRef && (checkpointRange || lastCheckpoints)) {
      exitWithUsage('Usage error: --base cannot be combined with --last-checkpoints or --checkpoint-range.');
    }

    if (checkpointRange && lastCheckpoints) {
      exitWithUsage('Usage error: --last-checkpoints and --checkpoint-range cannot be used together.');
    }

    if (commitModeRequested || (!workspaceId && !deploymentId)) {
      if (!commitModeRequested && !workspaceId && !deploymentId) {
        p.log.message('No review target flags provided; defaulting to `nimbus review create --commit HEAD`.');
      }
      await createReviewFromCommitCommand({
        commitish: typeof commitFlag === 'string' ? commitFlag : 'HEAD',
        baseRef,
        lastCheckpoints,
        checkpointRange,
        outputReviewIdPath: outputReviewIdPathForCommand,
        projectRoot,
        idempotencyKey,
        severityThreshold,
        maxFindings,
        policyMode,
        openStudio,
        openStudioPort,
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
      policyMode,
      openStudio,
      openStudioPort,
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
    const checkpointRangeFlag = flags['checkpoint-range'];
    const checkpointRange =
      typeof checkpointRangeFlag === 'string' && checkpointRangeFlag.trim() ? checkpointRangeFlag.trim() : undefined;
    const lastCheckpoints = parsePositiveIntegerFlag(flags['last-checkpoints']);
    if (typeof lastCheckpoints === 'number' && lastCheckpoints > 3) {
      exitWithUsage('Usage error: --last-checkpoints supports up to 3 in v1.');
    }
    if (baseRef && (checkpointRange || lastCheckpoints)) {
      exitWithUsage('Usage error: --base cannot be combined with --last-checkpoints or --checkpoint-range.');
    }
    if (checkpointRange && lastCheckpoints) {
      exitWithUsage('Usage error: --last-checkpoints and --checkpoint-range cannot be used together.');
    }
    await reviewPreflightCommand(typeof commitishArg === 'string' ? commitishArg : 'HEAD', {
      baseRef,
      lastCheckpoints,
      checkpointRange,
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

    await openReviewFromCommitCommand({
      port: parsePositiveIntegerFlag(flags.port),
      commitish: typeof flags.commit === 'string' ? flags.commit : 'HEAD',
      baseRef: typeof flags.base === 'string' && flags.base.trim() ? flags.base.trim() : undefined,
      projectRoot: typeof flags['project-root'] === 'string' && flags['project-root'].trim() ? flags['project-root'].trim() : undefined,
      idempotencyKey:
        typeof flags['idempotency-key'] === 'string' && flags['idempotency-key'].trim()
          ? flags['idempotency-key'].trim()
          : undefined,
      pollIntervalMs: parsePositiveIntegerFlag(flags['poll-interval-ms']),
    });
    return;
  }

  if (reviewAction === 'studio' || reviewAction === 'start') {
    const unexpectedPositional = positional[1];
    if (typeof unexpectedPositional === 'string' && unexpectedPositional.trim()) {
      exitWithUsage('Usage: nimbus review studio [--port <n>] [--detach]');
    }
    if (flags.serve && flags.status) {
      exitWithUsage('Usage error: --serve and --status cannot be used together.');
    }
    if (flags.serve && flags.stop) {
      exitWithUsage('Usage error: --serve and --stop cannot be used together.');
    }
    if (flags.status && flags.stop) {
      exitWithUsage('Usage error: --status and --stop cannot be used together.');
    }
    if (flags['dev-ui'] && flags.status) {
      exitWithUsage('Usage error: --dev-ui and --status cannot be used together.');
    }
    if (flags['dev-ui'] && flags.stop) {
      exitWithUsage('Usage error: --dev-ui and --stop cannot be used together.');
    }
    if (flags.detach && flags.serve) {
      exitWithUsage('Usage error: --detach and --serve cannot be used together.');
    }
    if (flags.detach && flags.status) {
      exitWithUsage('Usage error: --detach and --status cannot be used together.');
    }
    if (flags.detach && flags.stop) {
      exitWithUsage('Usage error: --detach and --stop cannot be used together.');
    }

    await startReviewStudioCommand({
      port: parsePositiveIntegerFlag(flags.port),
      serve: Boolean(flags.serve),
      status: Boolean(flags.status),
      stop: Boolean(flags.stop),
      devUi: Boolean(flags['dev-ui']),
      detach: Boolean(flags.detach),
    });
    return;
  }

  exitWithUsage('Unknown review command. Use: create, preflight, policy, show, events, studio, open, export');
}
