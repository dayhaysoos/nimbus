import type { Env, ReviewFinding, ReviewReport, ReviewRunResponse, ReviewSessionStopReason } from '../../types.js';
import {
  appendReviewEvent,
  appendWorkspaceTaskEvent,
  createWorkspaceTask,
  finalizeReviewSession,
  generateWorkspaceTaskId,
  getReviewSession,
  getWorkspace,
  getWorkspaceTask,
} from '../db.js';
import { loadRuntimeFlags } from '../flags.js';
import { createReviewSessionPass } from '../review-session-pass.js';
import { captureWorkspaceEnvironmentSnapshot } from './environment.js';
import { runWorkspaceTaskInlineWithRetries } from '../workspace-task-runner.js';
import { readWorkspaceFilesFromSandbox } from '../review-analysis.js';
import { asRecord, parseLocalCochangeFromProvenance, readOptionalNumber, readOptionalString } from './context-helpers.js';

const SAFE_AUTO_FIX_SEVERITIES = new Set<ReviewFinding['severity']>(['low', 'medium', 'high']);
const SAFE_AUTO_FIX_CATEGORIES = new Set<ReviewFinding['category']>(['style', 'logic']);
const RISKY_KEYWORD_PATTERN =
  /\b(schema|migration|database|sql|dependency|dependencies|package\.json|lockfile|library|auth|authentication|authorization|billing|payment|secret|credential|token|deployment|infra|production|rollback|queue|cache|storage)\b/i;
const MAX_REMEDIATION_FILE_SNAPSHOTS = 5;
const MAX_REMEDIATION_FILE_CHARS = 12_000;

function readFollowUpReviewScore(report: ReviewReport): 1 | 2 | 3 {
  const fromStructured = report.provenance.followUpReview?.score;
  if (fromStructured === 1 || fromStructured === 2 || fromStructured === 3) {
    return fromStructured;
  }
  const fromValidation = report.provenance.validation?.followUpReviewScore;
  if (fromValidation === 1 || fromValidation === 2 || fromValidation === 3) {
    return fromValidation;
  }
  return report.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical') ? 3 : 1;
}

function isRiskyFinding(finding: ReviewFinding): boolean {
  if (finding.category === 'security' || finding.category === 'breaking-change') {
    return true;
  }
  if (finding.locations.some((location) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i.test(location.filePath))) {
    return true;
  }

  const combinedText = `${finding.description}\n${finding.suggestedFix ?? ''}`;
  return RISKY_KEYWORD_PATTERN.test(combinedText);
}

function isSafeAutoFixFinding(finding: ReviewFinding): boolean {
  if (!SAFE_AUTO_FIX_SEVERITIES.has(finding.severity)) {
    return false;
  }
  if (!SAFE_AUTO_FIX_CATEGORIES.has(finding.category)) {
    return false;
  }
  if (finding.locations.length === 0) {
    return false;
  }
  if (isRiskyFinding(finding)) {
    return false;
  }
  return Boolean(finding.description.trim());
}

function buildRemediationPrompt(input: {
  reviewId: string;
  safeFindings: ReviewFinding[];
  riskyFindingCount: number;
  fileSnapshots: Array<{ path: string; content: string | null; truncated: boolean }>;
}): string {
  const lines: string[] = [
    'Apply the smallest safe code changes needed to address the review findings below.',
    'Work conservatively.',
    'Do not add dependencies, edit lockfiles, change schemas/migrations, or alter auth/deployment/infrastructure behavior.',
    'Only touch files referenced by the findings unless a tiny adjacent edit is required to make the fix correct.',
    'If a finding seems ambiguous or risky, leave the code unchanged and note that in the final summary.',
    'Prefer editing the exact file paths listed under Locations.',
    'Do not stop after listing files or probing a wrong path; either apply a safe edit to the referenced files or explain why the exact referenced file is missing.',
    `Source review: ${input.reviewId}`,
    `Safe findings to address: ${input.safeFindings.length}`,
  ];

  if (input.riskyFindingCount > 0) {
    lines.push(`Separate risky findings remain unresolved: ${input.riskyFindingCount}. Do not attempt those.`);
  }

  for (const [index, finding] of input.safeFindings.entries()) {
    lines.push('');
    lines.push(`Finding ${index + 1}`);
    lines.push(`Severity: ${finding.severity}`);
    lines.push(`Category: ${finding.category}`);
    lines.push(`Description: ${finding.description}`);
    if (finding.suggestedFix) {
      lines.push(`Suggested fix: ${finding.suggestedFix}`);
    }
    lines.push(
      `Locations: ${finding.locations
        .map((location) => `${location.filePath}:${location.startLine ?? '?'}-${location.endLine ?? '?'}`)
        .join(', ')}`
    );
  }

  if (input.fileSnapshots.length > 0) {
    lines.push('');
    lines.push('Current file snapshots');
    lines.push('Use these exact paths and contents as your starting point.');
    if (input.fileSnapshots.some((snapshot) => snapshot.truncated || snapshot.content === null)) {
      lines.push('If a file snapshot is marked as omitted due to size, call read_file for that path before any write_file edits.');
      lines.push('Do not overwrite a file using incomplete or omitted snapshot text.');
    }

    for (const snapshot of input.fileSnapshots) {
      lines.push('');
      lines.push(`File: ${snapshot.path}`);
      if (snapshot.truncated || snapshot.content === null) {
        lines.push('[snapshot omitted due to size; read_file required before edits]');
      } else {
        lines.push('```');
        lines.push(snapshot.content);
        lines.push('```');
      }
    }
  }

  lines.push('');
  lines.push('When finished, return a concise summary of what changed.');
  return lines.join('\n');
}

async function deriveFollowupLocalCochange(
  env: Env,
  review: ReviewRunResponse,
  report: ReviewReport
): Promise<
  | {
      source: 'local_git';
      checkpointsRef: string;
      lookbackSessions: number;
      topN: number;
      sessionsScanned: number;
      relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
    }
  | null
> {
  const reviewContextRef = report.provenance.reviewContextRef ?? review.provenance.reviewContextRef;
  if (!reviewContextRef?.r2Key) {
    return null;
  }
  const storageBucketCandidates = [env.REVIEW_CONTEXTS, env.WORKSPACE_ARTIFACTS, env.SOURCE_BUNDLES];
  const readableBuckets = storageBucketCandidates.filter(
    (bucket): bucket is R2Bucket => Boolean(bucket && typeof bucket.get === 'function')
  );
  if (readableBuckets.length === 0) {
    return null;
  }

  let object: R2ObjectBody | null = null;
  for (const bucket of readableBuckets) {
    try {
      const candidate = await bucket.get(reviewContextRef.r2Key);
      if (candidate) {
        object = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!object) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    return null;
  }

  const context = asRecord(parsed);
  const checkpoint = asRecord(context.checkpoint);
  const retrieval = asRecord(context.retrieval);
  const coChange = asRecord(retrieval.coChange);
  if (readOptionalString(coChange.source) !== 'local_git') {
    return null;
  }

  const checkpointsRef = readOptionalString(checkpoint.branch) ?? 'entire/checkpoints/v1';
  const lookbackSessions = Math.max(1, Math.floor(readOptionalNumber(coChange.lookbackSessions) ?? 5));
  const topN = Math.max(1, Math.floor(readOptionalNumber(coChange.topN) ?? 20));
  const sessionsScanned = Math.max(0, Math.floor(readOptionalNumber(coChange.sessionsScanned) ?? 0));
  const parsedLocalCochange = parseLocalCochangeFromProvenance({
    source: 'local_git',
    checkpointsRef,
    lookbackSessions,
    topN,
    sessionsScanned,
    relatedByChangedPath: retrieval.relatedByChangedPath,
  });
  if (!parsedLocalCochange || Object.keys(parsedLocalCochange.relatedByChangedPath).length === 0) {
    return null;
  }
  return parsedLocalCochange;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function defaultToolPolicy(): Record<string, unknown> {
  return {
    commands: {
      allow: ['git status', 'git diff', 'git add', 'git restore', 'ls', 'pwd'],
      deny: ['rm -rf /', 'sudo', 'curl', 'wget', 'ssh', 'dd', 'mkfs'],
    },
    filePaths: {
      root: '/workspace',
      deny: ['.git/**'],
    },
    limits: {
      maxCommandTimeoutMs: 900000,
      maxSteps: 60,
      maxOutputBytes: 32000,
    },
    autonomy: 'full',
  };
}

function resolveStopReason(input: {
  findings: ReviewFinding[];
  safeFindings: ReviewFinding[];
  followUpReviewScore: 1 | 2 | 3;
}): ReviewSessionStopReason | null {
  if (input.findings.length === 0) {
    return null;
  }
  if (input.followUpReviewScore === 1) {
    return 'diminishing_returns';
  }
  if (input.safeFindings.length === 0) {
    return input.findings.some(isRiskyFinding) ? 'risky_fix_requires_approval' : 'no_safe_fixes';
  }
  return null;
}

async function appendReviewEventBestEffort(
  env: Env,
  input: { reviewId: string; eventType: string; payload: Record<string, unknown> }
): Promise<void> {
  try {
    await appendReviewEvent(env.DB, input);
  } catch {
    // Best-effort telemetry only.
  }
}

function isActiveSessionStatus(status: ReviewRunResponse['status'] | null): boolean {
  return status === 'policy_pending' || status === 'policy_ready' || status === 'policy_approved' || status === 'queued' || status === 'running';
}

function successfulPassStopReason(sessionPassCount: number): ReviewSessionStopReason {
  return sessionPassCount > 1 ? 'followup_pass_completed' : 'initial_pass_completed';
}

export async function continueReviewSessionAfterSuccessfulPass(
  env: Env,
  review: ReviewRunResponse,
  report: ReviewReport
): Promise<{ nextReviewId: string | null }> {
  if (!review.sessionId) {
    return { nextReviewId: null };
  }

  const session = await getReviewSession(env.DB, review.sessionId);
  if (!session) {
    return { nextReviewId: null };
  }
  if (session.latestReviewId && session.latestReviewId !== review.id) {
    return { nextReviewId: null };
  }
  if (session.activeReviewId && session.activeReviewId !== review.id && isActiveSessionStatus(session.currentReviewStatus)) {
    return { nextReviewId: null };
  }

  const finalizeIfCurrent = async (stopReason: ReviewSessionStopReason): Promise<boolean> =>
    finalizeReviewSession(env.DB, session.id, {
      latestReviewId: review.id,
      stopReason,
      expectedLatestReviewId: review.id,
    });

  let terminalStopReasonApplied = false;

  try {
    const flags = await loadRuntimeFlags(env);
    if (!flags.workspaceAgentRuntimeEnabled || flags.maxRepairCycles <= 0) {
      await finalizeIfCurrent(successfulPassStopReason(session.passCount));
      return { nextReviewId: null };
    }
    if (report.findings.length === 0) {
      await finalizeIfCurrent(successfulPassStopReason(session.passCount));
      return { nextReviewId: null };
    }

    const followUpReviewScore = readFollowUpReviewScore(report);
    const safeFindings = report.findings.filter(isSafeAutoFixFinding);
    const stopReason = resolveStopReason({
      findings: report.findings,
      safeFindings,
      followUpReviewScore,
    });
    if (stopReason) {
      terminalStopReasonApplied = (await finalizeIfCurrent(stopReason)) || terminalStopReasonApplied;
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_skipped',
        payload: {
          reason: stopReason,
          followUpReviewScore,
          findingCount: report.findings.length,
          safeFindingCount: safeFindings.length,
        },
      });
      return { nextReviewId: null };
    }

    const repairCyclesUsed = Math.max(0, session.passCount - 1);
    if (repairCyclesUsed >= flags.maxRepairCycles) {
      terminalStopReasonApplied = (await finalizeIfCurrent('max_repair_cycles_reached')) || terminalStopReasonApplied;
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_skipped',
        payload: {
          reason: 'max_repair_cycles_reached',
          repairCyclesUsed,
          maxRepairCycles: flags.maxRepairCycles,
        },
      });
      return { nextReviewId: null };
    }

    const workspace = await getWorkspace(env.DB, session.workspaceId);
    if (!workspace || workspace.status !== 'ready') {
      terminalStopReasonApplied = (await finalizeIfCurrent('auto_remediation_failed')) || terminalStopReasonApplied;
      return { nextReviewId: null };
    }

    const remediationPaths = Array.from(
      new Set(
        safeFindings
          .flatMap((finding) => finding.locations.map((location) => location.filePath.trim()))
          .filter(Boolean)
      )
    ).slice(0, MAX_REMEDIATION_FILE_SNAPSHOTS);
    const remediationFileReads =
      remediationPaths.length > 0
        ? await readWorkspaceFilesFromSandbox(env, {
            sandboxId: workspace.sandboxId,
            paths: remediationPaths,
          })
        : [];
    const fileSnapshots = remediationFileReads
      .filter((entry) => entry.content !== null && !entry.error)
      .map((entry) => ({
        path: entry.path,
        content:
          entry.truncated || (entry.content ?? '').length > MAX_REMEDIATION_FILE_CHARS
            ? null
            : (entry.content ?? ''),
        truncated: entry.truncated || (entry.content ?? '').length > MAX_REMEDIATION_FILE_CHARS,
      }));

    const prompt = buildRemediationPrompt({
      reviewId: review.id,
      safeFindings,
      riskyFindingCount: report.findings.filter((finding) => !safeFindings.includes(finding)).length,
      fileSnapshots,
    });
    const preTaskWorkspaceSnapshot = await captureWorkspaceEnvironmentSnapshot(env, {
      id: session.workspaceId,
      status: workspace.status,
      sandboxId: workspace.sandboxId,
      baselineReady: workspace.baselineReady,
      sourceBundleKey: workspace.sourceBundleKey,
      sourceBundleSha256: workspace.sourceBundleSha256,
    });
    const provider = (env.AGENT_PROVIDER ?? 'cloudflare_agents_sdk').trim() || 'cloudflare_agents_sdk';
    const model = (env.AGENT_MODEL ?? env.REVIEW_MODEL ?? 'claude-3-7-sonnet').trim() || 'claude-3-7-sonnet';
    const maxSteps = Math.max(1, Math.min(120, Number.parseInt(env.WORKSPACE_AGENT_MAX_STEPS ?? '24', 10) || 24));
    const maxRetries = Math.max(0, Math.min(5, Number.parseInt(env.WORKSPACE_AGENT_MAX_RETRIES ?? '1', 10) || 1));
    const requestPayload = {
      prompt,
      provider,
      model,
      maxSteps,
      maxRetries,
    };
    const createdTask = await createWorkspaceTask(env.DB, {
      id: generateWorkspaceTaskId(),
      workspaceId: session.workspaceId,
      prompt,
      provider,
      model,
      idempotencyKey: `review-session-remediation:${session.id}:${review.id}`,
      requestPayload,
      requestPayloadSha256: await sha256Hex(JSON.stringify(requestPayload)),
      maxSteps,
      maxRetries,
      actorId: session.id,
      toolPolicy: defaultToolPolicy(),
    });

    if (!createdTask.reused) {
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId: session.workspaceId,
        taskId: createdTask.task.id,
        eventType: 'task_created',
        payload: {
          provider: createdTask.task.provider,
          model: createdTask.task.model,
          maxSteps: createdTask.task.maxSteps,
          maxRetries: createdTask.task.maxRetries,
        },
      });
    }

    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_auto_remediation_started',
      payload: {
        sessionId: session.id,
        taskId: createdTask.task.id,
        safeFindingCount: safeFindings.length,
        followUpReviewScore,
        reusedTask: createdTask.reused,
      },
    });

    if (createdTask.task.status === 'queued') {
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId: session.workspaceId,
        taskId: createdTask.task.id,
        eventType: 'task_enqueued',
        payload: {
          mode: 'inline',
          reused: createdTask.reused,
        },
      });
      await runWorkspaceTaskInlineWithRetries(env, session.workspaceId, createdTask.task.id, Math.max(1, maxRetries + 1));
    }

    const task = await getWorkspaceTask(env.DB, session.workspaceId, createdTask.task.id);
    if (!task || task.status !== 'succeeded') {
      terminalStopReasonApplied = (await finalizeIfCurrent('auto_remediation_failed')) || terminalStopReasonApplied;
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_failed',
        payload: {
          taskId: createdTask.task.id,
          status: task?.status ?? 'missing',
          error: task?.error ?? null,
        },
      });
      return { nextReviewId: null };
    }

    const workspaceSnapshot = await captureWorkspaceEnvironmentSnapshot(env, {
      id: session.workspaceId,
      status: workspace.status,
      sandboxId: workspace.sandboxId,
      baselineReady: workspace.baselineReady,
      sourceBundleKey: workspace.sourceBundleKey,
      sourceBundleSha256: workspace.sourceBundleSha256,
    });
    if (workspaceSnapshot.revision.diffSha256 === preTaskWorkspaceSnapshot.revision.diffSha256) {
      terminalStopReasonApplied = (await finalizeIfCurrent('no_progress')) || terminalStopReasonApplied;
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_skipped',
        payload: {
          reason: 'no_progress',
          taskId: task.id,
          preTaskDiffSha256: preTaskWorkspaceSnapshot.revision.diffSha256,
          postTaskDiffSha256: workspaceSnapshot.revision.diffSha256,
        },
      });
      return { nextReviewId: null };
    }

    const latestSession = await getReviewSession(env.DB, session.id);
    if (!latestSession) {
      return { nextReviewId: null };
    }
    if (latestSession.latestReviewId && latestSession.latestReviewId !== review.id) {
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_skipped',
        payload: {
          reason: 'session_state_advanced',
          latestReviewId: latestSession.latestReviewId,
          activeReviewId: latestSession.activeReviewId,
        },
      });
      return { nextReviewId: null };
    }
    if (
      latestSession.activeReviewId &&
      latestSession.activeReviewId !== review.id &&
      isActiveSessionStatus(latestSession.currentReviewStatus)
    ) {
      await appendReviewEventBestEffort(env, {
        reviewId: review.id,
        eventType: 'review_auto_remediation_skipped',
        payload: {
          reason: 'session_active_pass_conflict',
          latestReviewId: latestSession.latestReviewId,
          activeReviewId: latestSession.activeReviewId,
          currentReviewStatus: latestSession.currentReviewStatus,
        },
      });
      return { nextReviewId: null };
    }

    let followupLocalCochange: Awaited<ReturnType<typeof deriveFollowupLocalCochange>> = null;
    try {
      followupLocalCochange = await deriveFollowupLocalCochange(env, review, report);
    } catch {
      followupLocalCochange = null;
    }
    const followupPass = await createReviewSessionPass(env, {
      session: latestSession,
      reviewBasis: 'environment',
      environmentSnapshot: workspaceSnapshot,
      provenance: {
        trigger: 'session_auto_remediation',
        remediationSourceReviewId: review.id,
        remediationTaskId: task.id,
        ...(followupLocalCochange ? { localCochange: followupLocalCochange } : {}),
        remediationTaskSummary:
          task.result &&
          typeof task.result === 'object' &&
          !Array.isArray(task.result) &&
          typeof (task.result as { summary?: unknown }).summary === 'string'
            ? ((task.result as { summary: string }).summary)
            : null,
      },
      idempotencyKey: `review-session-remediation-pass:${session.id}:${review.id}`,
    });

    await appendReviewEventBestEffort(env, {
      reviewId: review.id,
      eventType: 'review_auto_remediation_completed',
      payload: {
        taskId: task.id,
        nextReviewId: followupPass.review.id,
        environmentRevision: followupPass.environmentSnapshot?.revision ?? null,
      },
    });

    return {
      nextReviewId: followupPass.review.id,
    };
  } catch (error) {
    if (!terminalStopReasonApplied) {
      await finalizeIfCurrent('auto_remediation_failed');
    }
    await appendReviewEventBestEffort(env, {
      reviewId: review.id,
      eventType: 'review_auto_remediation_failed',
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return { nextReviewId: null };
  }
}
