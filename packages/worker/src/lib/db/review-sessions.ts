import type {
  ReviewBasis,
  ReviewContextMode,
  ReviewEnvironmentRevision,
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewFindingSeverityV2,
  ReviewRecommendation,
  ReviewRunRecord,
  ReviewRunResponse,
  ReviewRunStatus,
  ReviewSessionPassSummary,
  ReviewSessionOutcomeSummary,
  ReviewSessionPhase,
  ReviewSessionRecord,
  ReviewSessionResponse,
  ReviewSessionStopReason,
  ReviewSeverity,
} from '../../types.js';
import { generatePrefixedId, parseJsonOrFallback, toReviewRunResponse } from './reviews/shared.js';

function normalizeReviewBasis(value: unknown): ReviewBasis {
  return value === 'environment' ? 'environment' : 'checkpoint';
}

function normalizeEnvironmentRevision(value: unknown): ReviewEnvironmentRevision | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.source !== 'workspace_head' ||
    typeof record.diffSha256 !== 'string' ||
    !record.diffSha256.trim() ||
    typeof record.changedFileCount !== 'number' ||
    !Number.isFinite(record.changedFileCount) ||
    record.changedFileCount < 0 ||
    typeof record.generatedAt !== 'string' ||
    !record.generatedAt.trim()
  ) {
    return undefined;
  }

  return {
    source: 'workspace_head',
    diffSha256: record.diffSha256.trim(),
    changedFileCount: Math.max(0, Math.floor(record.changedFileCount)),
    generatedAt: record.generatedAt.trim(),
  };
}

async function deriveInFlightRemediationPhase(
  db: D1Database,
  input: {
    workspaceId: string;
    latestReviewId: string | null;
    activeReviewId: string | null;
    currentReviewStatus: ReviewRunStatus | null;
    explicitStopReason: ReviewSessionStopReason | null;
  }
): Promise<{ phase: Extract<ReviewSessionPhase, 'fixing' | 'verifying'> | null; failed: boolean }> {
  if (
    !input.latestReviewId ||
    input.activeReviewId !== input.latestReviewId ||
    input.currentReviewStatus !== 'succeeded' ||
    input.explicitStopReason
  ) {
    return { phase: null, failed: false };
  }

  const remediationEvent = await db
    .prepare(
      `SELECT event_type, payload_json
       FROM review_events
       WHERE review_id = ?
         AND event_type IN (
           'review_auto_remediation_planned',
           'review_auto_remediation_started',
           'review_auto_remediation_completed',
           'review_auto_remediation_failed',
           'review_auto_remediation_skipped'
         )
       ORDER BY seq DESC
       LIMIT 1`
    )
    .bind(input.latestReviewId)
    .first<{ event_type: string; payload_json: string | null }>();

  if (!remediationEvent) {
    return { phase: null, failed: false };
  }

  if (remediationEvent.event_type === 'review_auto_remediation_planned') {
    return { phase: 'fixing', failed: false };
  }
  if (remediationEvent.event_type !== 'review_auto_remediation_started') {
    return { phase: null, failed: false };
  }

  const payload = parseJsonOrFallback<Record<string, unknown>>(remediationEvent.payload_json, {});
  const taskId = typeof payload.taskId === 'string' && payload.taskId.trim().length > 0 ? payload.taskId.trim() : null;
  if (!taskId) {
    return { phase: 'fixing', failed: false };
  }

  const task = await db
    .prepare(
      `SELECT status
       FROM workspace_tasks
       WHERE id = ? AND workspace_id = ?`
    )
    .bind(taskId, input.workspaceId)
    .first<{ status: string | null }>();

  if (task?.status === 'queued' || task?.status === 'running') {
    return { phase: 'fixing', failed: false };
  }
  if (task?.status === 'succeeded') {
    return { phase: 'verifying', failed: false };
  }
  if (task?.status === 'failed' || task?.status === 'cancelled') {
    return { phase: null, failed: true };
  }

  return { phase: null, failed: false };
}

function deriveSessionPhase(
  status: ReviewRunStatus | null,
  stopReason: ReviewSessionStopReason | null,
  options?: { hasActiveCurrentPass?: boolean; remediationPhase?: Extract<ReviewSessionPhase, 'fixing' | 'verifying'> | null }
): ReviewSessionPhase {
  if (options?.remediationPhase) {
    return options.remediationPhase;
  }
  if (
    options?.hasActiveCurrentPass &&
    (status === 'queued' || status === 'running' || status === 'policy_approved')
  ) {
    return 'reviewing';
  }
  if (stopReason === 'risky_fix_requires_approval') {
    return 'waiting_on_human';
  }
  if (stopReason === 'auto_remediation_failed') {
    return 'failed';
  }
  switch (status) {
    case 'policy_pending':
    case 'policy_ready':
      return 'waiting_on_human';
    case 'running':
      return 'reviewing';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'policy_approved':
    case 'queued':
    default:
      return 'preparing';
  }
}

function deriveStopReason(status: ReviewRunStatus | null, passCount = 1): ReviewSessionStopReason | null {
  switch (status) {
    case 'succeeded':
      return passCount > 1 ? 'followup_pass_completed' : 'initial_pass_completed';
    case 'failed':
      return passCount > 1 ? 'followup_pass_failed' : 'initial_pass_failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function severityRank(value: ReviewFindingSeverityV2): number {
  switch (value) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'info':
    default:
      return 1;
  }
}

function statusRank(value: ReviewEvidenceItem['status']): number {
  switch (value) {
    case 'failed':
      return 4;
    case 'warning':
      return 3;
    case 'passed':
      return 2;
    case 'info':
    default:
      return 1;
  }
}

function normalizeContextMode(value: unknown): ReviewContextMode | null {
  return value === 'basic' || value === 'intent_aware' ? value : null;
}

function readRequestPayload(record: ReviewRunRecord): Record<string, unknown> {
  return parseJsonOrFallback<Record<string, unknown>>(record.request_payload_json, {});
}

function readRequestProvenance(requestPayload: Record<string, unknown>): Record<string, unknown> {
  const requestProvenance =
    requestPayload.provenance && typeof requestPayload.provenance === 'object' && !Array.isArray(requestPayload.provenance)
      ? (requestPayload.provenance as Record<string, unknown>)
      : {};
  return requestProvenance;
}

function toPassSummary(review: ReviewRunResponse, requestPayload: Record<string, unknown>): ReviewSessionPassSummary {
  const requestProvenance = readRequestProvenance(requestPayload);
  const environmentRevision = normalizeEnvironmentRevision(requestProvenance.environmentRevision);

  return {
    reviewId: review.id,
    status: review.status,
    reviewBasis: normalizeReviewBasis(requestPayload.reviewBasis ?? review.reviewBasis),
    ...(environmentRevision ? { environmentRevision } : {}),
    createdAt: review.createdAt,
    startedAt: review.startedAt,
    finishedAt: review.finishedAt,
  };
}

function summarizeEvidence(reviews: ReviewRunResponse[]): ReviewSessionOutcomeSummary['evidence'] {
  const latestByKey = new Map<string, ReviewEvidenceItem>();

  const evidenceKey = (item: ReviewEvidenceItem): string => {
    if (typeof item.id === 'string' && item.id.trim().length > 0) {
      return `id:${item.id.trim()}`;
    }
    return `fallback:${JSON.stringify([item.type, item.label, item.metadata ?? null])}`;
  };

  for (const review of reviews) {
    const evidence = Array.isArray(review.evidence) ? review.evidence : [];
    for (const item of evidence) {
      latestByKey.set(evidenceKey(item), item);
    }
  }

  const deduped = [...latestByKey.values()];

  const counts = deduped.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { passed: 0, failed: 0, warning: 0, info: 0 }
  );

  const highlights = [...deduped]
    .sort((left, right) => statusRank(right.status) - statusRank(left.status))
    .slice(0, 5);

  return {
    ...counts,
    highlights,
  };
}

function summarizeUnresolved(findings: ReviewFinding[]): ReviewSessionOutcomeSummary['unresolved'] {
  const sorted = [...findings].sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  return {
    findingCount: findings.length,
    highestSeverity: sorted[0]?.severity ?? null,
    highlights: sorted.slice(0, 3).map((finding) => {
      const firstLocation = Array.isArray(finding.locations) && finding.locations.length > 0 ? finding.locations[0] : null;
      return {
        severity: finding.severity,
        category: finding.category,
        description: finding.description,
        filePath: firstLocation?.filePath ?? null,
      };
    }),
  };
}

function deriveOutcomeKind(input: {
  stopReason: ReviewSessionStopReason | null;
  currentReviewStatus: ReviewRunStatus | null;
  unresolvedFindingCount: number;
  hasTerminalState: boolean;
}): ReviewSessionOutcomeSummary['kind'] | null {
  if (!input.hasTerminalState) {
    return null;
  }

  switch (input.stopReason) {
    case 'cancelled':
      return 'cancelled';
    case 'risky_fix_requires_approval':
      return 'converged_with_blockers';
    case 'initial_pass_failed':
    case 'followup_pass_failed':
    case 'auto_remediation_failed':
    case 'no_safe_fixes':
      return 'blocked';
    case 'diminishing_returns':
    case 'no_progress':
    case 'max_repair_cycles_reached':
      return 'exhausted';
    default:
      break;
  }

  if (input.currentReviewStatus === 'cancelled') {
    return 'cancelled';
  }
  if (input.currentReviewStatus === 'failed') {
    return 'blocked';
  }
  if (input.currentReviewStatus === 'succeeded' && input.unresolvedFindingCount === 0) {
    return 'clean';
  }
  if (input.currentReviewStatus === 'succeeded') {
    return 'converged_with_blockers';
  }

  if (input.hasTerminalState && input.unresolvedFindingCount === 0) {
    return 'clean';
  }
  if (input.hasTerminalState) {
    return 'converged_with_blockers';
  }

  return null;
}

function summarizeOutcomeText(input: {
  kind: ReviewSessionOutcomeSummary['kind'];
  latestReview: ReviewRunResponse | null;
  stopReason: ReviewSessionStopReason | null;
  remediationCount: number;
  unresolvedFindingCount: number;
}): string | null {
  const latestSummary = input.latestReview?.summaryText?.trim();
  const remediationSummary =
    input.remediationCount > 0 ? `Nimbus applied ${input.remediationCount} remediation pass${input.remediationCount === 1 ? '' : 'es'}.` : null;

  switch (input.kind) {
    case 'clean':
      return latestSummary ?? remediationSummary ?? 'Nimbus completed review and no actionable findings remain.';
    case 'converged_with_blockers':
      if (input.stopReason === 'risky_fix_requires_approval') {
        return 'Nimbus stopped because the remaining fixes require human approval.';
      }
      return latestSummary ?? `Nimbus stopped with ${input.unresolvedFindingCount} unresolved finding${input.unresolvedFindingCount === 1 ? '' : 's'}.`;
    case 'blocked':
      if (input.stopReason === 'no_safe_fixes') {
        return 'Nimbus found remaining issues but could not apply a safe automatic fix.';
      }
      if (input.stopReason === 'auto_remediation_failed') {
        return 'Nimbus attempted remediation but the fix pass failed.';
      }
      return latestSummary ?? 'Nimbus could not continue the review session safely.';
    case 'exhausted':
      if (input.stopReason === 'diminishing_returns') {
        return 'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.';
      }
      if (input.stopReason === 'no_progress') {
        return 'Nimbus stopped because remediation did not materially change the workspace state.';
      }
      if (input.stopReason === 'no_progress_after_remediation') {
        return 'Nimbus stopped because the follow-up pass reproduced the same targeted findings after remediation.';
      }
      if (input.stopReason === 'max_repair_cycles_reached') {
        return 'Nimbus stopped after reaching the configured remediation budget.';
      }
      return latestSummary ?? 'Nimbus exhausted its automatic remediation budget.';
    case 'cancelled':
      return 'Nimbus cancelled the review session before it reached a final verified state.';
    default:
      return latestSummary ?? null;
  }
}

function deriveOutcome(
  input: {
    phase: ReviewSessionPhase;
    stopReason: ReviewSessionStopReason | null;
    currentReviewStatus: ReviewRunStatus | null;
    passCount: number;
    latestReview: ReviewRunResponse | null;
    passSummaries: ReviewSessionPassSummary[];
    passRecords: Array<{ review: ReviewRunResponse; requestPayload: Record<string, unknown> }>;
    hasActiveNonTerminalPass: boolean;
  }
): ReviewSessionOutcomeSummary | null {
  const latestReview = input.latestReview;
  const unresolved = summarizeUnresolved(latestReview?.findings ?? []);
  const remediationPasses = input.passRecords.flatMap(({ requestPayload }) => {
    const requestProvenance = readRequestProvenance(requestPayload);
    const trigger = typeof requestProvenance.trigger === 'string' ? requestProvenance.trigger.trim() : '';
    if (trigger !== 'session_auto_remediation') {
      return [];
    }
    const summary =
      typeof requestProvenance.remediationTaskSummary === 'string' && requestProvenance.remediationTaskSummary.trim()
        ? requestProvenance.remediationTaskSummary.trim()
        : null;
    return [{ summary }];
  });
  const remediationSummaries = Array.from(
    new Set(
      remediationPasses
        .map((item) => item.summary)
        .filter((item): item is string => Boolean(item))
    )
  );
  const latestEnvironmentRevision = input.passSummaries
    .slice()
    .reverse()
    .find((pass) => pass.environmentRevision)?.environmentRevision ?? null;
  const kind = deriveOutcomeKind({
    stopReason: input.stopReason,
    currentReviewStatus: input.currentReviewStatus,
    unresolvedFindingCount: unresolved.findingCount,
    hasTerminalState:
      !input.hasActiveNonTerminalPass &&
      (input.phase === 'completed' || input.phase === 'failed' || input.phase === 'cancelled' || input.phase === 'waiting_on_human'),
  });
  if (!kind) {
    return null;
  }

  return {
    kind,
    summary: summarizeOutcomeText({
      kind,
      latestReview,
      stopReason: input.stopReason,
      remediationCount: remediationPasses.length,
      unresolvedFindingCount: unresolved.findingCount,
    }),
    residualRisk: latestReview?.summary?.riskLevel ?? null,
    recommendation: latestReview?.summary?.recommendation ?? null,
    materializeReady: input.currentReviewStatus === 'succeeded' && Boolean(latestEnvironmentRevision && latestEnvironmentRevision.changedFileCount > 0),
    reviewed: {
      contextMode: normalizeContextMode(latestReview?.provenance.reviewContextMode),
      latestReviewBasis: input.passSummaries[input.passSummaries.length - 1]?.reviewBasis ?? null,
      passCount: input.passCount,
    },
    changes: {
      applied: remediationPasses.length > 0 && Boolean(latestEnvironmentRevision && latestEnvironmentRevision.changedFileCount > 0),
      remediationCount: remediationPasses.length,
      changedFileCount: latestEnvironmentRevision?.changedFileCount ?? 0,
      summaries: remediationSummaries,
      environmentRevision: latestEnvironmentRevision,
    },
    evidence: summarizeEvidence(input.passRecords.map((item) => item.review)),
    unresolved,
  };
}

async function toReviewSessionResponse(
  record: ReviewSessionRecord,
  passRecords: ReviewRunRecord[],
  db: D1Database
): Promise<ReviewSessionResponse> {
  const parsedPasses = passRecords.map((passRecord) => {
    const requestPayload = readRequestPayload(passRecord);
    const review = toReviewRunResponse(passRecord);
    return {
      requestPayload,
      review,
    };
  });
  const passSummaries = parsedPasses.map(({ review, requestPayload }) => toPassSummary(review, requestPayload));
  const latestPass = passSummaries[passSummaries.length - 1] ?? null;
  const latestReview = parsedPasses[parsedPasses.length - 1]?.review ?? null;
  const currentReviewStatus = latestPass?.status ?? null;
  const derivedPassCount = typeof record.pass_count === 'number' ? record.pass_count : passSummaries.length;
  const hasActiveCurrentPass = Boolean(record.active_review_id && latestPass?.reviewId === record.active_review_id);
  const remediationState = await deriveInFlightRemediationPhase(db, {
    workspaceId: record.workspace_id,
    latestReviewId: record.latest_review_id,
    activeReviewId: record.active_review_id,
    currentReviewStatus,
    explicitStopReason: record.stop_reason,
  });
  const remediationPhase = remediationState.phase;
  const hasInFlightRemediation = Boolean(remediationPhase);
  const hasActiveNonTerminalPass =
    hasActiveCurrentPass &&
    (currentReviewStatus === 'queued' ||
      currentReviewStatus === 'running' ||
      currentReviewStatus === 'policy_pending' ||
      currentReviewStatus === 'policy_ready' ||
      currentReviewStatus === 'policy_approved');
  const derivedUpdatedAt =
    latestPass?.finishedAt ?? latestPass?.startedAt ?? latestPass?.createdAt ?? record.updated_at;
  const derivedFinishedAt =
    record.finished_at ?? (!hasActiveNonTerminalPass && !hasInFlightRemediation ? (latestPass?.finishedAt ?? null) : null);
  const stopReason =
    record.stop_reason ??
    (remediationState.failed
      ? 'auto_remediation_failed'
      : !hasActiveNonTerminalPass && !hasInFlightRemediation
        ? deriveStopReason(currentReviewStatus, derivedPassCount)
        : null);
  const phase = deriveSessionPhase(currentReviewStatus, stopReason, {
    hasActiveCurrentPass,
    remediationPhase,
  });
  const outcome = deriveOutcome({
    phase,
    stopReason,
    currentReviewStatus,
    passCount: derivedPassCount,
    latestReview,
    passSummaries,
    passRecords: parsedPasses,
    hasActiveNonTerminalPass: hasActiveNonTerminalPass || hasInFlightRemediation,
  });

  return {
    id: record.id,
    workspaceId: record.workspace_id,
    anchorDeploymentId: record.anchor_deployment_id,
    repo: record.repo,
    branch: record.branch,
    initialReviewBasis: normalizeReviewBasis(record.initial_review_basis),
    anchorCommitSha: record.anchor_commit_sha,
    anchorCheckpointId: record.anchor_checkpoint_id,
    sourceProjectRoot: record.source_project_root,
    phase,
    passCount: derivedPassCount,
    activeReviewId: record.active_review_id,
    latestReviewId: record.latest_review_id,
    currentReviewStatus,
    stopReason,
    createdAt: record.created_at,
    updatedAt: derivedUpdatedAt,
    finishedAt: derivedFinishedAt,
    passes: passSummaries,
    outcome,
  };
}

export function generateReviewSessionId(): string {
  return generatePrefixedId('session');
}

export async function createReviewSession(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    anchorDeploymentId: string;
    repo: string;
    branch: string;
    initialReviewBasis: ReviewBasis;
    anchorCommitSha?: string | null;
    anchorCheckpointId?: string | null;
    sourceProjectRoot?: string | null;
    accountId?: string | null;
  }
): Promise<ReviewSessionResponse> {
  const now = new Date().toISOString();
  const record = await db
    .prepare(
      `INSERT INTO review_sessions (
         id,
         workspace_id,
         anchor_deployment_id,
         repo,
         branch,
         initial_review_basis,
         anchor_commit_sha,
         anchor_checkpoint_id,
         source_project_root,
         account_id,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.anchorDeploymentId,
      input.repo,
      input.branch,
      input.initialReviewBasis,
      input.anchorCommitSha ?? null,
      input.anchorCheckpointId ?? null,
      input.sourceProjectRoot ?? null,
      input.accountId ?? null,
      now,
      now
    )
    .first<ReviewSessionRecord>();

  if (!record) {
    throw new Error('Failed to create review session');
  }

  return toReviewSessionResponse(record, [], db);
}

export async function attachReviewPassToSession(
  db: D1Database,
  sessionId: string,
  reviewId: string,
  options?: { terminalStatus?: ReviewRunStatus | null }
): Promise<void> {
  const terminalStatus = options?.terminalStatus ?? null;
  const finishedAt = terminalStatus === 'succeeded' || terminalStatus === 'failed' || terminalStatus === 'cancelled'
    ? new Date().toISOString()
    : null;
  await db
    .prepare(
      `UPDATE review_sessions
       SET active_review_id = ?,
           latest_review_id = ?,
           pass_count = CASE
             WHEN latest_review_id IS NULL THEN 1
             WHEN latest_review_id = ? THEN pass_count
             ELSE pass_count + 1
           END,
           stop_reason = ?,
           finished_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      reviewId,
      reviewId,
      reviewId,
      deriveStopReason(terminalStatus),
      finishedAt,
      new Date().toISOString(),
      sessionId
    )
    .run();
}

export async function finalizeReviewSession(
  db: D1Database,
  sessionId: string,
  input: {
    latestReviewId?: string | null;
    stopReason: ReviewSessionStopReason;
    expectedLatestReviewId?: string | null;
  }
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE review_sessions
       SET active_review_id = NULL,
            latest_review_id = COALESCE(?, latest_review_id),
            stop_reason = ?,
            finished_at = COALESCE(finished_at, ?),
            updated_at = ?
       WHERE id = ?
         AND (? IS NULL OR latest_review_id = ?)`
    )
    .bind(
      input.latestReviewId ?? null,
      input.stopReason,
      now,
      now,
      sessionId,
      input.expectedLatestReviewId ?? null,
      input.expectedLatestReviewId ?? null
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteReviewSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM review_sessions WHERE id = ?').bind(sessionId).run();
}

export async function getReviewSession(db: D1Database, sessionId: string): Promise<ReviewSessionResponse | null> {
  const record = await db.prepare('SELECT * FROM review_sessions WHERE id = ?').bind(sessionId).first<ReviewSessionRecord>();
  if (!record) {
    return null;
  }

  const passes = await db
    .prepare(
      `SELECT *
       FROM review_runs
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .bind(sessionId)
    .all<ReviewRunRecord>();

  return toReviewSessionResponse(record, passes.results, db);
}

function resolveListLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

export async function listReviewSessions(
  db: D1Database,
  options?: { limit?: number; accountId?: string; repo?: string; branch?: string }
): Promise<ReviewSessionResponse[]> {
  const resolvedLimit = resolveListLimit(options?.limit);
  const whereClauses: string[] = [];
  const values: Array<string | number> = [];

  if (typeof options?.accountId === 'string' && options.accountId.trim()) {
    whereClauses.push('account_id = ?');
    values.push(options.accountId.trim());
  }
  if (typeof options?.repo === 'string' && options.repo.trim()) {
    whereClauses.push('repo = ?');
    values.push(options.repo.trim());
  }
  if (typeof options?.branch === 'string' && options.branch.trim()) {
    whereClauses.push('branch = ?');
    values.push(options.branch.trim());
  }

  const query = [
    'SELECT * FROM review_sessions',
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '',
    'ORDER BY updated_at DESC, created_at DESC, id DESC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join(' ');

  values.push(resolvedLimit);

  const result = await db.prepare(query).bind(...values).all<ReviewSessionRecord>();
  if (result.results.length === 0) {
    return [];
  }

  const sessionIds = result.results.map((record) => record.id);
  const placeholders = sessionIds.map(() => '?').join(', ');
  const passRows = await db
    .prepare(
      `SELECT *
       FROM review_runs
       WHERE session_id IN (${placeholders})
       ORDER BY session_id ASC, created_at ASC, id ASC`
    )
    .bind(...sessionIds)
    .all<ReviewRunRecord>();

  const passesBySession = new Map<string, ReviewRunRecord[]>();
  for (const pass of passRows.results) {
    if (!pass.session_id) {
      continue;
    }
    const existing = passesBySession.get(pass.session_id) ?? [];
    existing.push(pass);
    passesBySession.set(pass.session_id, existing);
  }

  return Promise.all(
    result.results.map((record) => toReviewSessionResponse(record, passesBySession.get(record.id) ?? [], db))
  );
}

export async function getReviewSessionAccountId(
  db: D1Database,
  sessionId: string
): Promise<string | null | undefined> {
  const result = await db
    .prepare('SELECT account_id FROM review_sessions WHERE id = ?')
    .bind(sessionId)
    .first<{ account_id: string | null }>();
  if (!result) {
    return undefined;
  }
  return result.account_id;
}

export async function getReviewSessionByReviewId(
  db: D1Database,
  reviewId: string
): Promise<ReviewSessionResponse | null> {
  const row = await db
    .prepare('SELECT session_id FROM review_runs WHERE id = ?')
    .bind(reviewId)
    .first<{ session_id: string | null }>();

  if (!row?.session_id) {
    return null;
  }

  return getReviewSession(db, row.session_id);
}
