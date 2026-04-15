import type {
  GetReviewSessionResponse,
  GetReviewResponse,
  LocalReviewEnvironment,
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentListResponse,
  LocalReviewEnvironmentMergeBackResponse,
  ListReviewsResponse,
  ReviewCategory,
  ReviewContextMode,
  ReviewBasis,
  ReviewFailureGuidance,
  ReviewFinding,
  ReviewConfidence,
  ReviewHistoryItem,
  ReviewPassType,
  ReviewRecommendation,
  ReviewResponse,
  ReviewSessionListResponse,
  ReviewSessionPhase,
  ReviewSessionResponse,
  ReviewSeverity,
  StudioLocalReviewEnvironment,
  WorkspaceDiffResponse,
  StudioReviewedDiffResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartResponse,
  StudioNewReviewStartStreamEvent,
  StudioPreflightIssueCode,
  StudioSessionActivityEvent,
  StudioSessionActivitySnapshot,
  StudioSessionActivitySnapshotResponse,
  StudioSessionAggregateResponse,
  StudioSessionFindingRollupEntry,
  StudioContextResponse,
  ReviewStatus,
} from '../types';

export const DEFAULT_COUNTS = {
  info: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid review payload: ${label} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readStatus(value: unknown): ReviewStatus {
  if (
    value === 'policy_pending' ||
    value === 'policy_ready' ||
    value === 'policy_approved' ||
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new Error('Invalid review payload: review status is invalid.');
}

function readReviewBasis(value: unknown): ReviewBasis {
  if (value === 'checkpoint' || value === 'environment') {
    return value;
  }
  throw new Error('Invalid review payload: review basis is invalid.');
}

function readContextMode(value: unknown): ReviewContextMode {
  if (value === 'basic' || value === 'intent_aware') {
    return value;
  }
  throw new Error('Invalid review payload: context mode is invalid.');
}

function readOptionalContextMode(value: unknown): ReviewContextMode | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readContextMode(value);
}

function readSessionPhase(value: unknown): ReviewSessionPhase {
  if (
    value === 'preparing' ||
    value === 'reviewing' ||
    value === 'fixing' ||
    value === 'verifying' ||
    value === 'waiting_on_human' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new Error('Invalid review payload: review session phase is invalid.');
}

function readStopReason(value: unknown): ReviewSessionResponse['stopReason'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    value === 'initial_pass_completed' ||
    value === 'initial_pass_failed' ||
    value === 'followup_pass_completed' ||
    value === 'followup_pass_failed' ||
    value === 'diminishing_returns' ||
    value === 'risky_fix_requires_approval' ||
    value === 'no_safe_fixes' ||
    value === 'no_progress' ||
    value === 'no_progress_after_remediation' ||
    value === 'max_repair_cycles_reached' ||
    value === 'auto_remediation_failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new Error('Invalid review payload: review session stopReason is invalid.');
}

function readPolicyDraft(value: unknown): { goal: string | null; prohibitions: string[]; constraints: string[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const goal = readOptionalString(record.goal);
  const normalizeList = (input: unknown): string[] =>
    Array.isArray(input)
      ? Array.from(
          new Set(
            input
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean)
          )
        )
      : [];

  const prohibitions = normalizeList(record.prohibitions);
  const constraints = normalizeList(record.constraints);
  if (!goal && prohibitions.length === 0 && constraints.length === 0) {
    return undefined;
  }

  return {
    goal,
    prohibitions,
    constraints,
  };
}

function readSeverity(value: unknown): ReviewSeverity {
  if (value === 'info' || value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new Error('Invalid review payload: finding severity is invalid.');
}

function readCategory(value: unknown): ReviewCategory {
  if (value === 'security' || value === 'logic' || value === 'style' || value === 'breaking-change' || value === 'unknown') {
    return value;
  }
  throw new Error('Invalid review payload: finding category is invalid.');
}

function readPassType(value: unknown): ReviewPassType {
  if (
    value === 'single' ||
    value === 'security' ||
    value === 'logic' ||
    value === 'style' ||
    value === 'breaking-change' ||
    value === 'unknown'
  ) {
    return value;
  }
  throw new Error('Invalid review payload: finding passType is invalid.');
}

function readOptionalConfidence(value: unknown): ReviewConfidence | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return undefined;
}

function readRecommendation(value: unknown): ReviewRecommendation {
  if (value === 'approve' || value === 'comment' || value === 'request_changes') {
    return value;
  }
  throw new Error('Invalid review payload: summary recommendation is invalid.');
}

function readRiskLevel(value: unknown): 'critical' | 'high' | 'medium' | 'low' {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new Error('Invalid review payload: summary riskLevel is invalid.');
}

function readTargetType(value: unknown): 'workspace_deployment' {
  if (value === 'workspace_deployment') {
    return value;
  }
  throw new Error('Invalid review payload: target.type must be workspace_deployment.');
}

function readMode(value: unknown): 'report_only' {
  if (value === 'report_only') {
    return value;
  }
  throw new Error('Invalid review payload: mode must be report_only.');
}

function readHistoryRiskLevel(value: unknown): ReviewHistoryItem['riskLevel'] {
  if (value === null || value === undefined) {
    return null;
  }
  return readRiskLevel(value);
}

function readHistoryRecommendation(value: unknown): ReviewHistoryItem['recommendation'] {
  if (value === null || value === undefined) {
    return null;
  }
  return readRecommendation(value);
}

function readNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid review payload: ${label} must be a string or null.`);
  }
  return value;
}

function readEnvironmentRevision(value: unknown): ReviewSessionResponse['passes'][number]['environmentRevision'] {
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
    throw new Error('Invalid review payload: environment revision is invalid.');
  }

  return {
    source: 'workspace_head',
    diffSha256: record.diffSha256.trim(),
    changedFileCount: Math.max(0, Math.floor(record.changedFileCount)),
    generatedAt: record.generatedAt.trim(),
  };
}

function readEvidenceList(value: unknown): ReviewResponse['evidence'] {
  return Array.isArray(value)
    ? value.map((item, index) => {
        const evidenceItem = asRecord(item);
        return {
          id: readString(evidenceItem.id, `evidence[${index}].id`),
          type: readString(evidenceItem.type, `evidence[${index}].type`),
          label: readString(evidenceItem.label, `evidence[${index}].label`),
          status:
            evidenceItem.status === 'passed' ||
            evidenceItem.status === 'failed' ||
            evidenceItem.status === 'warning' ||
            evidenceItem.status === 'info'
              ? evidenceItem.status
              : 'info',
          metadata:
            evidenceItem.metadata && typeof evidenceItem.metadata === 'object'
              ? (evidenceItem.metadata as Record<string, unknown>)
              : undefined,
        };
      })
    : [];
}

function readFindings(value: unknown): ReviewFinding[] {
  return Array.isArray(value)
    ? value.map((item) => {
        const finding = asRecord(item);
        const locations = Array.isArray(finding.locations)
          ? finding.locations.map((locationItem) => {
              const location = asRecord(locationItem);
              const path = readOptionalString(location.path);
              if (path) {
                const line = location.line;
                if (!Number.isInteger(line) || (line as number) <= 0) {
                  throw new Error('Invalid review payload: finding location line is invalid.');
                }
                return {
                  filePath: path,
                  startLine: line as number,
                  endLine: line as number,
                };
              }

              const startLine = location.startLine;
              const endLine = location.endLine;
              const hasNullRange = startLine === null && endLine === null;
              const hasNumberRange =
                Number.isInteger(startLine) &&
                (startLine as number) > 0 &&
                Number.isInteger(endLine) &&
                (endLine as number) >= (startLine as number);
              if (!hasNullRange && !hasNumberRange) {
                throw new Error('Invalid review payload: finding location line range is invalid.');
              }
              return {
                filePath: readString(location.filePath, 'finding location filePath'),
                startLine: hasNullRange ? null : (startLine as number),
                endLine: hasNullRange ? null : (endLine as number),
              };
            })
          : [];

        const title = readOptionalString(finding.title);
        const description = readOptionalString(finding.description) ?? title ?? 'No description provided.';
        const suggestedFixValue =
          typeof finding.suggestedFix === 'string'
            ? finding.suggestedFix
            : finding.suggestedFix && typeof finding.suggestedFix === 'object' && !Array.isArray(finding.suggestedFix)
              ? readOptionalString((finding.suggestedFix as Record<string, unknown>).value) ?? ''
              : '';

        return {
          ...(readOptionalString(finding.id) ? { id: readOptionalString(finding.id) ?? undefined } : {}),
          severity: readSeverity(finding.severity),
          category:
            finding.category === undefined || finding.category === null ? 'unknown' : readCategory(finding.category),
          passType:
            finding.passType === undefined || finding.passType === null ? 'unknown' : readPassType(finding.passType),
          ...(readOptionalConfidence(finding.confidence) ? { confidence: readOptionalConfidence(finding.confidence) } : {}),
          ...(title ? { title } : {}),
          description,
          ...(finding.conditions === undefined ? {} : { conditions: readOptionalString(finding.conditions) }),
          locations,
          suggestedFix: suggestedFixValue,
          ...(Array.isArray(finding.evidenceRefs) ? { evidenceRefs: readStringList(finding.evidenceRefs) } : {}),
        };
      })
    : [];
}

export function parseGetReviewResponse(payload: unknown): GetReviewResponse {
  const root = asRecord(payload);
  const review = asRecord(root.review);
  if (!root.review || Object.keys(review).length === 0) {
    throw new Error('No review payload in response.');
  }

  const summaryRecord = review.summary === undefined ? null : asRecord(review.summary);
  const findings = readFindings(review.findings);

  const targetRecord = asRecord(review.target);
  const provenanceRecord = asRecord(review.provenance);
  const contextResolutionRecord = asRecord(provenanceRecord.contextResolution);
  const coChangeRecord = asRecord(provenanceRecord.coChange);
  const validationRecord = asRecord(provenanceRecord.validation);
  const furtherPassesSignalRecord = asRecord(provenanceRecord.furtherPassesLowYield);
  const reviewContextRefRecord = asRecord(provenanceRecord.reviewContextRef);
  const reviewContextStatsRecord = asRecord(provenanceRecord.reviewContextStats);
  const reviewedFilesRecord = asRecord(provenanceRecord.reviewedFiles);
  const intentRecord = asRecord(review.intent);
  const errorRecord = asRecord(review.error);

  return {
    review: {
      id: readString(review.id, 'review id'),
      workspaceId: readString(review.workspaceId, 'workspaceId'),
      deploymentId: readString(review.deploymentId, 'deploymentId'),
      target: {
        type: readTargetType(targetRecord.type),
        workspaceId: readString(targetRecord.workspaceId, 'target.workspaceId'),
        deploymentId: readString(targetRecord.deploymentId, 'target.deploymentId'),
      },
      mode: readMode(review.mode),
      status: readStatus(review.status),
      idempotencyKey: readString(review.idempotencyKey, 'idempotencyKey'),
      attemptCount: Number.isInteger(review.attemptCount) ? (review.attemptCount as number) : 0,
      derivedPolicy: readPolicyDraft(review.derivedPolicy),
      approvedPolicy: readPolicyDraft(review.approvedPolicy),
      approvedPolicySha256: readOptionalString(review.approvedPolicySha256) ?? undefined,
      createdAt: readString(review.createdAt, 'createdAt'),
      updatedAt: readString(review.updatedAt, 'updatedAt'),
      startedAt: readNullableTimestamp(review.startedAt, 'startedAt'),
      finishedAt: readNullableTimestamp(review.finishedAt, 'finishedAt'),
      summary:
        summaryRecord && Object.keys(summaryRecord).length > 0
          ? {
              riskLevel: readRiskLevel(summaryRecord.riskLevel),
              recommendation: readRecommendation(summaryRecord.recommendation),
              findingCounts: {
                info: Number(summaryRecord.findingCounts && asRecord(summaryRecord.findingCounts).info) || 0,
                critical: Number(summaryRecord.findingCounts && asRecord(summaryRecord.findingCounts).critical) || 0,
                high: Number(summaryRecord.findingCounts && asRecord(summaryRecord.findingCounts).high) || 0,
                medium: Number(summaryRecord.findingCounts && asRecord(summaryRecord.findingCounts).medium) || 0,
                low: Number(summaryRecord.findingCounts && asRecord(summaryRecord.findingCounts).low) || 0,
              },
            }
          : undefined,
      summaryText: typeof review.summaryText === 'string' ? review.summaryText : undefined,
      furtherPassesLowYield:
        typeof review.furtherPassesLowYield === 'boolean' ? review.furtherPassesLowYield : undefined,
      findings,
      intent:
        Object.keys(intentRecord).length > 0
          ? {
              goal: readOptionalString(intentRecord.goal),
              constraints: Array.isArray(intentRecord.constraints)
                ? intentRecord.constraints.filter((item): item is string => typeof item === 'string')
                : [],
              decisions: Array.isArray(intentRecord.decisions)
                ? intentRecord.decisions.filter((item): item is string => typeof item === 'string')
                : [],
            }
          : undefined,
      evidence: Array.isArray(review.evidence)
        ? review.evidence.map((item, index) => {
            const evidenceItem = asRecord(item);
            return {
              id: readString(evidenceItem.id, `evidence[${index}].id`),
              type: readString(evidenceItem.type, `evidence[${index}].type`),
              label: readString(evidenceItem.label, `evidence[${index}].label`),
              status:
                evidenceItem.status === 'passed' ||
                evidenceItem.status === 'failed' ||
                evidenceItem.status === 'warning' ||
                evidenceItem.status === 'info'
                  ? evidenceItem.status
                  : 'info',
              metadata: evidenceItem.metadata && typeof evidenceItem.metadata === 'object'
                ? (evidenceItem.metadata as Record<string, unknown>)
                : undefined,
            };
          })
        : [],
      provenance: {
        sessionIds: Array.isArray(provenanceRecord.sessionIds)
          ? provenanceRecord.sessionIds.filter((item): item is string => typeof item === 'string')
          : [],
        promptSummary: readOptionalString(provenanceRecord.promptSummary),
        transcriptUrl: readOptionalString(provenanceRecord.transcriptUrl),
        reviewContextRef:
          Object.keys(reviewContextRefRecord).length > 0
            ? {
                id: readString(reviewContextRefRecord.id, 'provenance.reviewContextRef.id'),
                r2Key: readString(reviewContextRefRecord.r2Key, 'provenance.reviewContextRef.r2Key'),
              }
            : null,
        reviewContextStats:
          Object.keys(reviewContextStatsRecord).length > 0
            ? {
                totalFilesIncluded: Number(reviewContextStatsRecord.totalFilesIncluded) || 0,
                totalBytesIncluded: Number(reviewContextStatsRecord.totalBytesIncluded) || 0,
                estimatedTokens: Number(reviewContextStatsRecord.estimatedTokens) || 0,
                tokenBudget:
                  reviewContextStatsRecord.tokenBudget === null
                    ? null
                    : typeof reviewContextStatsRecord.tokenBudget === 'number' &&
                        Number.isFinite(reviewContextStatsRecord.tokenBudget)
                      ? reviewContextStatsRecord.tokenBudget
                      : null,
              }
            : undefined,
        reviewedFiles:
          Object.keys(reviewedFilesRecord).length > 0
            ? {
                changed: readStringList(reviewedFilesRecord.changed),
                related: readStringList(reviewedFilesRecord.related),
                conventions: readStringList(reviewedFilesRecord.conventions),
              }
            : undefined,
        coChange:
          Object.keys(coChangeRecord).length > 0
            ? {
                coChangeSkipped: coChangeRecord.coChangeSkipped === true,
                coChangeSkipReason: readOptionalString(coChangeRecord.coChangeSkipReason),
                coChangeAvailable: coChangeRecord.coChangeAvailable === true,
                relatedFileCount: Number(coChangeRecord.relatedFileCount) || 0,
              }
            : undefined,
        contextResolution:
          contextResolutionRecord.contextResolution === 'direct' ||
          contextResolutionRecord.contextResolution === 'branch_fallback'
            ? {
                contextResolution: contextResolutionRecord.contextResolution,
                originalCheckpointId: readString(
                  contextResolutionRecord.originalCheckpointId,
                  'provenance.contextResolution.originalCheckpointId'
                ),
                resolvedCheckpointId: readString(
                  contextResolutionRecord.resolvedCheckpointId,
                  'provenance.contextResolution.resolvedCheckpointId'
                ),
                resolvedCommitSha: readString(
                  contextResolutionRecord.resolvedCommitSha,
                  'provenance.contextResolution.resolvedCommitSha'
                ),
                resolvedCommitMessage: readOptionalString(contextResolutionRecord.resolvedCommitMessage),
              }
            : undefined,
        outputSchemaVersion: provenanceRecord.outputSchemaVersion === 'v2' ? 'v2' : undefined,
        passArchitecture: provenanceRecord.passArchitecture === 'single' ? 'single' : undefined,
        validation:
          Object.keys(validationRecord).length > 0
            ? {
                firstPassValid: validationRecord.firstPassValid === true,
                repairAttempted: validationRecord.repairAttempted === true,
                repairSucceeded: validationRecord.repairSucceeded === true,
                validationErrorCount: Number(validationRecord.validationErrorCount) || 0,
                dedupedExactCount: Number(validationRecord.dedupedExactCount) || 0,
                fallbackApplied:
                  validationRecord.fallbackApplied === undefined
                    ? undefined
                    : validationRecord.fallbackApplied === true,
                fallbackReason: readOptionalString(validationRecord.fallbackReason),
              }
            : undefined,
        furtherPassesLowYield:
          Object.keys(furtherPassesSignalRecord).length > 0 &&
          typeof furtherPassesSignalRecord.value === 'boolean' &&
          furtherPassesSignalRecord.source === 'model-self-assessment' &&
          furtherPassesSignalRecord.reliability === 'weak-signal-phase2'
            ? {
                value: furtherPassesSignalRecord.value,
                source: 'model-self-assessment',
                reliability: 'weak-signal-phase2',
              }
            : undefined,
        advisories: Array.isArray(provenanceRecord.advisories)
          ? provenanceRecord.advisories.filter((item): item is string => typeof item === 'string')
          : undefined,
      },
      markdownSummary: review.markdownSummary === null ? null : readString(review.markdownSummary, 'markdownSummary'),
      error:
        Object.keys(errorRecord).length > 0
          ? {
              code: readString(errorRecord.code, 'error.code'),
              message: readString(errorRecord.message, 'error.message'),
            }
          : undefined,
    },
  };
}

function parseReviewSessionResponseValue(value: unknown): ReviewSessionResponse {
  const session = asRecord(value);
  if (Object.keys(session).length === 0) {
    throw new Error('Invalid review session payload: session is required.');
  }

  const outcomeRecord = asRecord(session.outcome);
  const reviewedRecord = asRecord(outcomeRecord.reviewed);
  const changesRecord = asRecord(outcomeRecord.changes);
  const evidenceRecord = asRecord(outcomeRecord.evidence);
  const unresolvedRecord = asRecord(outcomeRecord.unresolved);

  return {
    id: readString(session.id, 'session.id'),
    workspaceId: readString(session.workspaceId, 'session.workspaceId'),
    anchorDeploymentId: readString(session.anchorDeploymentId, 'session.anchorDeploymentId'),
    repo: readString(session.repo, 'session.repo'),
    branch: readString(session.branch, 'session.branch'),
    initialReviewBasis: readReviewBasis(session.initialReviewBasis),
    anchorCommitSha: readOptionalString(session.anchorCommitSha),
    anchorCheckpointId: readOptionalString(session.anchorCheckpointId),
    sourceProjectRoot: readOptionalString(session.sourceProjectRoot),
    phase: readSessionPhase(session.phase),
    passCount: Number(session.passCount) || 0,
    activeReviewId: readOptionalString(session.activeReviewId),
    latestReviewId: readOptionalString(session.latestReviewId),
    currentReviewStatus:
      session.currentReviewStatus === null || session.currentReviewStatus === undefined
        ? null
        : readStatus(session.currentReviewStatus),
    stopReason: readStopReason(session.stopReason),
    createdAt: readString(session.createdAt, 'session.createdAt'),
    updatedAt: readString(session.updatedAt, 'session.updatedAt'),
    finishedAt: readNullableTimestamp(session.finishedAt, 'session.finishedAt'),
    passes: Array.isArray(session.passes)
      ? session.passes.map((item, index) => {
          const pass = asRecord(item);
          return {
            reviewId: readString(pass.reviewId, `session.passes[${index}].reviewId`),
            status: readStatus(pass.status),
            reviewBasis: readReviewBasis(pass.reviewBasis),
            ...(pass.environmentRevision !== undefined
              ? { environmentRevision: readEnvironmentRevision(pass.environmentRevision) }
              : {}),
            createdAt: readString(pass.createdAt, `session.passes[${index}].createdAt`),
            startedAt: readNullableTimestamp(pass.startedAt, `session.passes[${index}].startedAt`),
            finishedAt: readNullableTimestamp(pass.finishedAt, `session.passes[${index}].finishedAt`),
          };
        })
      : [],
    outcome:
      Object.keys(outcomeRecord).length > 0
        ? {
            kind:
              outcomeRecord.kind === 'clean' ||
              outcomeRecord.kind === 'converged_with_blockers' ||
              outcomeRecord.kind === 'blocked' ||
              outcomeRecord.kind === 'exhausted' ||
              outcomeRecord.kind === 'cancelled'
                ? outcomeRecord.kind
                : 'blocked',
            summary: readOptionalString(outcomeRecord.summary),
            residualRisk:
              outcomeRecord.residualRisk === null || outcomeRecord.residualRisk === undefined
                ? null
                : readSeverity(outcomeRecord.residualRisk),
            recommendation:
              outcomeRecord.recommendation === null || outcomeRecord.recommendation === undefined
                ? null
                : readRecommendation(outcomeRecord.recommendation),
            materializeReady: outcomeRecord.materializeReady === true,
            reviewed: {
              contextMode: readOptionalContextMode(reviewedRecord.contextMode),
              latestReviewBasis:
                reviewedRecord.latestReviewBasis === null || reviewedRecord.latestReviewBasis === undefined
                  ? null
                  : readReviewBasis(reviewedRecord.latestReviewBasis),
              passCount: Number(reviewedRecord.passCount) || 0,
            },
            changes: {
              applied: changesRecord.applied === true,
              remediationCount: Number(changesRecord.remediationCount) || 0,
              changedFileCount: Number(changesRecord.changedFileCount) || 0,
              summaries: readStringList(changesRecord.summaries),
              environmentRevision:
                changesRecord.environmentRevision === null || changesRecord.environmentRevision === undefined
                  ? null
                  : (readEnvironmentRevision(changesRecord.environmentRevision) ?? null),
            },
            evidence: {
              passed: Number(evidenceRecord.passed) || 0,
              failed: Number(evidenceRecord.failed) || 0,
              warning: Number(evidenceRecord.warning) || 0,
              info: Number(evidenceRecord.info) || 0,
              highlights: readEvidenceList(evidenceRecord.highlights),
            },
            unresolved: {
              findingCount: Number(unresolvedRecord.findingCount) || 0,
              highestSeverity:
                unresolvedRecord.highestSeverity === null || unresolvedRecord.highestSeverity === undefined
                  ? null
                  : readSeverity(unresolvedRecord.highestSeverity),
              highlights: Array.isArray(unresolvedRecord.highlights)
                ? unresolvedRecord.highlights.map((item, index) => {
                    const highlight = asRecord(item);
                    return {
                      severity: readSeverity(highlight.severity),
                      category: readCategory(highlight.category),
                      description: readString(
                        highlight.description,
                        `session.outcome.unresolved.highlights[${index}].description`
                      ),
                      filePath: readOptionalString(highlight.filePath),
                    };
                  })
                : [],
            },
          }
        : null,
  };
}

export function parseGetReviewSessionResponse(payload: unknown): GetReviewSessionResponse {
  const root = asRecord(payload);
  return {
    session: parseReviewSessionResponseValue(root.session),
  };
}

export function parseListReviewSessionsResponse(payload: unknown): ReviewSessionListResponse {
  const root = asRecord(payload);
  if (!Array.isArray(root.sessions)) {
    throw new Error('Invalid review session payload: sessions must be an array.');
  }
  return {
    sessions: root.sessions.map((item) => parseReviewSessionResponseValue(item)),
  };
}

export function parseListReviewsResponse(payload: unknown): ListReviewsResponse {
  const root = asRecord(payload);
  if (!Array.isArray(root.reviews)) {
    throw new Error('Invalid review list payload: reviews must be an array.');
  }

  const reviews = root.reviews.map((item, index) => {
    const record = asRecord(item);
    const errorRecord = asRecord(record.error);

    return {
      id: readString(record.id, `reviews[${index}].id`),
      workspaceId: readString(record.workspaceId, `reviews[${index}].workspaceId`),
      deploymentId: readString(record.deploymentId, `reviews[${index}].deploymentId`),
      repo: readString(record.repo, `reviews[${index}].repo`),
      branch: readString(record.branch, `reviews[${index}].branch`),
      status: readStatus(record.status),
      createdAt: readString(record.createdAt, `reviews[${index}].createdAt`),
      updatedAt: readString(record.updatedAt, `reviews[${index}].updatedAt`),
      startedAt: readNullableTimestamp(record.startedAt, `reviews[${index}].startedAt`),
      finishedAt: readNullableTimestamp(record.finishedAt, `reviews[${index}].finishedAt`),
      findingCount:
        record.findingCount === null
          ? null
          : Number.isInteger(record.findingCount) && (record.findingCount as number) >= 0
            ? (record.findingCount as number)
            : null,
      riskLevel: readHistoryRiskLevel(record.riskLevel),
      recommendation: readHistoryRecommendation(record.recommendation),
      summaryText: readOptionalString(record.summaryText),
      error:
        Object.keys(errorRecord).length > 0
          ? {
              code: readString(errorRecord.code, `reviews[${index}].error.code`),
              message: readString(errorRecord.message, `reviews[${index}].error.message`),
            }
          : undefined,
    } satisfies ReviewHistoryItem;
  });

  return { reviews };
}

export function parseStudioContextResponse(payload: unknown): StudioContextResponse {
  const root = asRecord(payload);
  const repo = root.repo;
  const branch = root.branch;
  const detectedAt = root.detectedAt;
  if (repo !== null && repo !== undefined && typeof repo !== 'string') {
    throw new Error('Invalid studio context payload: repo must be a string or null.');
  }
  if (branch !== null && branch !== undefined && typeof branch !== 'string') {
    throw new Error('Invalid studio context payload: branch must be a string or null.');
  }
  if (typeof detectedAt !== 'string' || !detectedAt.trim()) {
    throw new Error('Invalid studio context payload: detectedAt must be a non-empty string.');
  }
  return {
    repo: typeof repo === 'string' ? repo : null,
    branch: typeof branch === 'string' ? branch : null,
    detectedAt,
  };
}

export function parseStudioNewReviewPreflightResponse(payload: unknown): StudioNewReviewPreflightResponse {
  const root = asRecord(payload);
  const repo = root.repo;
  const branch = root.branch;
  if (repo !== null && repo !== undefined && typeof repo !== 'string') {
    throw new Error('Invalid Studio preflight payload: repo must be a string or null.');
  }
  if (branch !== null && branch !== undefined && typeof branch !== 'string') {
    throw new Error('Invalid Studio preflight payload: branch must be a string or null.');
  }
  if (root.policyMode !== 'auto' && root.policyMode !== 'review') {
    throw new Error('Invalid Studio preflight payload: policyMode must be auto or review.');
  }
  const lastCheckpoints = Number(root.lastCheckpoints);
  if (lastCheckpoints !== 1 && lastCheckpoints !== 2 && lastCheckpoints !== 3) {
    throw new Error('Invalid Studio preflight payload: lastCheckpoints must be 1, 2, or 3.');
  }
  if (root.checkpointSelectionMode !== 'latest' && root.checkpointSelectionMode !== 'last_n') {
    throw new Error('Invalid Studio preflight payload: checkpointSelectionMode must be latest or last_n.');
  }
  if (root.checkpointId !== null && root.checkpointId !== undefined && typeof root.checkpointId !== 'string') {
    throw new Error('Invalid Studio preflight payload: checkpointId must be a string or null.');
  }
  if (root.commitSha !== null && root.commitSha !== undefined && typeof root.commitSha !== 'string') {
    throw new Error('Invalid Studio preflight payload: commitSha must be a string or null.');
  }
  if (typeof root.ready !== 'boolean') {
    throw new Error('Invalid Studio preflight payload: ready must be boolean.');
  }

  const startability =
    root.startability === 'blocked' || root.startability === 'basic' || root.startability === 'intent_aware'
      ? root.startability
      : root.ready
        ? root.contextMode === 'basic'
          ? 'basic'
          : 'intent_aware'
        : 'blocked';

  const capabilitiesRecord = asRecord(root.capabilities);
  const capabilities =
    Object.keys(capabilitiesRecord).length > 0
      ? {
          canStart: capabilitiesRecord.canStart === true,
          canStartInBasicMode: capabilitiesRecord.canStartInBasicMode === true,
          canStartInIntentAwareMode: capabilitiesRecord.canStartInIntentAwareMode === true,
          canReviewPolicy: capabilitiesRecord.canReviewPolicy === true,
        }
      : {
          canStart: startability !== 'blocked',
          canStartInBasicMode: startability === 'basic' || startability === 'intent_aware',
          canStartInIntentAwareMode: startability === 'intent_aware',
          canReviewPolicy: startability !== 'blocked',
        };

  const readIssueCode = (value: unknown): StudioPreflightIssueCode => {
    if (
      value === 'checkpoint_unavailable' ||
      value === 'checkpoint_missing_trailer' ||
      value === 'entire_context_unavailable' ||
      value === 'branch_context_changed' ||
      value === 'unknown'
    ) {
      return value;
    }
    return 'unknown';
  };

  const parseIssueList = (value: unknown, field: 'blockingIssues' | 'warnings') => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item, index) => {
      const issue = asRecord(item);
      return {
        code: readIssueCode(issue.code),
        message: readString(issue.message, `${field}[${index}].message`),
      };
    });
  };

  const parseCheckpointCount = (
    value: unknown,
    label: string,
    fallback: 1 | 2 | 3
  ): 1 | 2 | 3 => {
    const count = Number(value);
    if (count === 1 || count === 2 || count === 3) {
      return count;
    }
    if (value === undefined || value === null) {
      return fallback;
    }
    throw new Error(`Invalid Studio preflight payload: ${label} must be 1, 2, or 3.`);
  };

  const requestedLastCheckpoints = parseCheckpointCount(root.requestedLastCheckpoints, 'requestedLastCheckpoints', lastCheckpoints as 1 | 2 | 3);
  const effectiveLastCheckpoints = parseCheckpointCount(root.effectiveLastCheckpoints, 'effectiveLastCheckpoints', lastCheckpoints as 1 | 2 | 3);

  if (!Array.isArray(root.checks)) {
    throw new Error('Invalid Studio preflight payload: checks must be an array.');
  }
  const checks = root.checks.map((item, index) => {
    const check = asRecord(item);
    if (check.code !== 'checkpoint' && check.code !== 'entire_context') {
      throw new Error(`Invalid Studio preflight payload: checks[${index}].code is invalid.`);
    }
    return {
      code: check.code as 'checkpoint' | 'entire_context',
      label: readString(check.label, `checks[${index}].label`),
      ok: Boolean(check.ok),
      detail: readString(check.detail, `checks[${index}].detail`),
    };
  });

  const includedCheckpoints = Array.isArray(root.includedCheckpoints)
    ? root.includedCheckpoints
        .flatMap((item, index) => {
          const entry = asRecord(item);
          if (!entry || Object.keys(entry).length === 0) {
            return [];
          }
          const checkpointId = readOptionalString(entry.checkpointId);
          const commitSha = readOptionalString(entry.commitSha);
          if (!checkpointId || !commitSha) {
            throw new Error(`Invalid Studio preflight payload: includedCheckpoints[${index}] is invalid.`);
          }
          return [
            {
              checkpointId,
              commitSha,
              commitSubject: readOptionalString(entry.commitSubject) ?? '',
            },
          ];
        })
        .slice(0, 3)
    : [];

  const errorRecord = asRecord(root.error);
  const error =
    Object.keys(errorRecord).length > 0
      ? {
          code: readIssueCode(errorRecord.code),
          message: readString(errorRecord.message, 'error.message'),
        }
      : undefined;

  return {
    repo: typeof repo === 'string' ? repo : null,
    branch: typeof branch === 'string' ? branch : null,
    policyMode: root.policyMode,
    startability,
    contextMode: root.contextMode === undefined ? 'intent_aware' : readContextMode(root.contextMode),
    requestedLastCheckpoints,
    effectiveLastCheckpoints,
    lastCheckpoints: lastCheckpoints as 1 | 2 | 3,
    checkpointSelectionMode: root.checkpointSelectionMode,
    checkpointId: typeof root.checkpointId === 'string' ? root.checkpointId : null,
    commitSha: typeof root.commitSha === 'string' ? root.commitSha : null,
    includedCheckpoints,
    ready: root.ready,
    capabilities,
    blockingIssues: parseIssueList(root.blockingIssues, 'blockingIssues'),
    warnings: parseIssueList(root.warnings, 'warnings'),
    checks,
    error,
  };
}

export function parseStudioNewReviewStartResponse(payload: unknown): StudioNewReviewStartResponse {
  const root = asRecord(payload);
  const reviewId = readString(root.reviewId, 'reviewId');
  const routePath = readString(root.routePath, 'routePath');
  if (root.policyMode !== 'auto' && root.policyMode !== 'review') {
    throw new Error('Invalid Studio start payload: policyMode must be auto or review.');
  }
  if (root.status !== 'policy_ready' && root.status !== 'queued') {
    throw new Error('Invalid Studio start payload: status must be policy_ready or queued.');
  }

  const sessionId = readOptionalString(root.sessionId);
  const defaultCheckpointCount = (() => {
    const count = Number(root.lastCheckpoints);
    if (count === 1 || count === 2 || count === 3) {
      return count as 1 | 2 | 3;
    }
    return 1 as const;
  })();
  const requestedLastCheckpoints = Number(root.requestedLastCheckpoints ?? defaultCheckpointCount);
  const effectiveLastCheckpoints = Number(root.effectiveLastCheckpoints ?? defaultCheckpointCount);
  if (requestedLastCheckpoints !== 1 && requestedLastCheckpoints !== 2 && requestedLastCheckpoints !== 3) {
    throw new Error('Invalid Studio start payload: requestedLastCheckpoints must be 1, 2, or 3.');
  }
  if (effectiveLastCheckpoints !== 1 && effectiveLastCheckpoints !== 2 && effectiveLastCheckpoints !== 3) {
    throw new Error('Invalid Studio start payload: effectiveLastCheckpoints must be 1, 2, or 3.');
  }

  return {
    reviewId,
    sessionId,
    routePath,
    policyMode: root.policyMode,
    contextMode: readContextMode(root.contextMode),
    requestedLastCheckpoints: requestedLastCheckpoints as 1 | 2 | 3,
    effectiveLastCheckpoints: effectiveLastCheckpoints as 1 | 2 | 3,
    status: root.status,
  };
}

export function parseStudioNewReviewStartStreamEvent(payload: unknown): StudioNewReviewStartStreamEvent {
  const root = asRecord(payload);

  if (root.type === 'stage') {
    const validStage =
      root.stage === 'checkpoint' ||
      root.stage === 'entire_context' ||
      root.stage === 'cochange' ||
      root.stage === 'workspace' ||
      root.stage === 'deployment' ||
      root.stage === 'review_creation' ||
      root.stage === 'policy';
    if (!validStage) {
      throw new Error('Invalid Studio start stream payload: stage is invalid.');
    }
    if (root.state !== 'active' && root.state !== 'completed') {
      throw new Error('Invalid Studio start stream payload: stage state is invalid.');
    }
    const stage = root.stage as
      | 'checkpoint'
      | 'entire_context'
      | 'cochange'
      | 'workspace'
      | 'deployment'
      | 'review_creation'
      | 'policy';
    return {
      type: 'stage',
      stage,
      state: root.state,
      label: readString(root.label, 'label'),
      detail: readString(root.detail, 'detail'),
    };
  }

  if (root.type === 'completed') {
    const parsed = parseStudioNewReviewStartResponse(root);
    return {
      type: 'completed',
      ...parsed,
      detail: readString(root.detail, 'detail'),
    };
  }

  if (root.type === 'error') {
    return {
      type: 'error',
      message: readString(root.message, 'message'),
    };
  }

  throw new Error('Invalid Studio start stream payload: type is invalid.');
}

export function parseWorkspaceDiffResponse(payload: unknown): WorkspaceDiffResponse {
  const root = asRecord(payload);
  const summary = asRecord(root.summary);
  return {
    workspaceId: readString(root.workspaceId, 'workspaceId'),
    includePatch: root.includePatch === true,
    maxBytes: Number(root.maxBytes) || 0,
    truncated: root.truncated === true,
    changedFilesTruncated: root.changedFilesTruncated === undefined ? undefined : root.changedFilesTruncated === true,
    patchTruncated: root.patchTruncated === undefined ? undefined : root.patchTruncated === true,
    summaryIsPartial: root.summaryIsPartial === undefined ? undefined : root.summaryIsPartial === true,
    summary: {
      added: Number(summary.added) || 0,
      modified: Number(summary.modified) || 0,
      deleted: Number(summary.deleted) || 0,
      renamed: Number(summary.renamed) || 0,
      totalChanged: Number(summary.totalChanged) || 0,
    },
    changedFiles: Array.isArray(root.changedFiles)
      ? root.changedFiles.map((item, index) => {
          const file = asRecord(item);
          const status =
            file.status === 'added' || file.status === 'modified' || file.status === 'deleted' || file.status === 'renamed'
              ? file.status
              : null;
          if (!status) {
            throw new Error(`Invalid workspace diff payload: changedFiles[${index}].status is invalid.`);
          }
          return {
            path: readString(file.path, `changedFiles[${index}].path`),
            status,
            ...(typeof file.previousPath === 'string' && file.previousPath.trim()
              ? { previousPath: file.previousPath }
              : {}),
          };
        })
      : [],
    changedFilesBytes: root.changedFilesBytes === undefined ? undefined : Number(root.changedFilesBytes) || 0,
    changedFilesTotalBytes: root.changedFilesTotalBytes === undefined ? undefined : Number(root.changedFilesTotalBytes) || 0,
    patch: typeof root.patch === 'string' ? root.patch : undefined,
    patchBytes: root.patchBytes === undefined ? undefined : Number(root.patchBytes) || 0,
    patchTotalBytes: root.patchTotalBytes === undefined ? undefined : Number(root.patchTotalBytes) || 0,
  };
}

function parseLocalReviewEnvironment(value: unknown): LocalReviewEnvironment {
  const root = asRecord(value);
  const environmentRevision = readEnvironmentRevision(root.environmentRevision);
  if (!environmentRevision) {
    throw new Error('Invalid local review environment payload: environmentRevision is required.');
  }
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    repoRoot: readString(root.repoRoot, 'repoRoot'),
    repo: readOptionalString(root.repo),
    branchName: readString(root.branchName, 'branchName'),
    mode: root.mode === 'branch' ? 'branch' : 'worktree',
    worktreePath: readOptionalString(root.worktreePath),
    artifactId: readString(root.artifactId, 'artifactId'),
    artifactSha256: readString(root.artifactSha256, 'artifactSha256'),
    latestReviewId: readString(root.latestReviewId, 'latestReviewId'),
    anchorCommitSha: readString(root.anchorCommitSha, 'anchorCommitSha'),
    commitSha: readOptionalString(root.commitSha),
    environmentRevision,
    contextMode:
      root.contextMode === 'unknown' ? 'unknown' : readContextMode(root.contextMode),
    materializedAt: readString(root.materializedAt, 'materializedAt'),
    enterCommand: readString(root.enterCommand, 'enterCommand'),
  };
}

export function parseLocalReviewEnvironmentListResponse(payload: unknown): LocalReviewEnvironmentListResponse {
  const root = asRecord(payload);
  if (!Array.isArray(root.environments)) {
    throw new Error('Invalid local review environment payload: environments must be an array.');
  }
  return {
    environments: root.environments.map((item) => parseLocalReviewEnvironment(item)),
  };
}

export function parseLocalReviewEnvironmentDiffResponse(payload: unknown): LocalReviewEnvironmentDiffResponse {
  const root = asRecord(payload);
  return {
    entry: parseLocalReviewEnvironment(root.entry),
    baseRef: readString(root.baseRef, 'baseRef'),
    diff: typeof root.diff === 'string' ? root.diff : '',
    hasDiff: root.hasDiff === true,
    enterCommand: readString(root.enterCommand, 'enterCommand'),
  };
}

export function parseLocalReviewEnvironmentMergeBackResponse(
  payload: unknown
): LocalReviewEnvironmentMergeBackResponse {
  const root = asRecord(payload);
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    currentBranch: readString(root.currentBranch, 'currentBranch'),
    sourceBranch: readString(root.sourceBranch, 'sourceBranch'),
    sourceCommit: readString(root.sourceCommit, 'sourceCommit'),
    newHead: readOptionalString(root.newHead),
    worktreePath: readOptionalString(root.worktreePath),
    status: root.status === 'already_applied' ? 'already_applied' : 'applied',
  };
}

function parseStudioSessionActivitySnapshotValue(value: unknown): StudioSessionActivitySnapshot {
  const root = asRecord(value);
  const state =
    root.state === 'active' || root.state === 'waiting_on_human' || root.state === 'terminal'
      ? root.state
      : null;
  if (!state) {
    throw new Error('Invalid Studio session activity payload: state is invalid.');
  }

  return {
    sessionId: readString(root.sessionId, 'activity.sessionId'),
    phase: readSessionPhase(root.phase),
    state,
    currentReviewStatus:
      root.currentReviewStatus === null || root.currentReviewStatus === undefined
        ? null
        : readStatus(root.currentReviewStatus),
    activeReviewId: readOptionalString(root.activeReviewId),
    latestReviewId: readOptionalString(root.latestReviewId),
    passCount: Number(root.passCount) || 0,
    summary: readString(root.summary, 'activity.summary'),
    detail: readString(root.detail, 'activity.detail'),
    canStream: root.canStream === true,
    streamPath: readString(root.streamPath, 'activity.streamPath'),
    updatedAt: readString(root.updatedAt, 'activity.updatedAt'),
  };
}

function parseStudioLocalReviewEnvironment(value: unknown): StudioLocalReviewEnvironment {
  const root = asRecord(value);
  const base = parseLocalReviewEnvironment(root);
  return {
    ...base,
    diffPath: readString(root.diffPath, 'environment.diffPath'),
    mergeBackPath: readString(root.mergeBackPath, 'environment.mergeBackPath'),
  };
}

function parseStudioSessionFindingRollupEntry(value: unknown, label: string): StudioSessionFindingRollupEntry {
  const root = asRecord(value);
  const parsedFinding = readFindings([root.finding])[0];
  if (!parsedFinding) {
    throw new Error(`Invalid Studio session payload: ${label}.finding is invalid.`);
  }
  return {
    finding: parsedFinding,
    state: root.state === 'unresolved' ? 'unresolved' : 'resolved',
    firstSeenReviewId: readString(root.firstSeenReviewId, `${label}.firstSeenReviewId`),
    lastSeenReviewId: readString(root.lastSeenReviewId, `${label}.lastSeenReviewId`),
    reviewIds: readStringList(root.reviewIds),
  };
}

export function parseStudioSessionActivitySnapshotResponse(payload: unknown): StudioSessionActivitySnapshotResponse {
  const root = asRecord(payload);
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    activity: parseStudioSessionActivitySnapshotValue(root.activity),
  };
}

export function parseStudioSessionActivityEvent(payload: unknown): StudioSessionActivityEvent {
  const root = asRecord(payload);
  if (root.type === 'snapshot') {
    return {
      type: 'snapshot',
      sessionId: readString(root.sessionId, 'sessionId'),
      activity: parseStudioSessionActivitySnapshotValue(root.activity),
    };
  }
  if (root.type === 'terminal') {
    return {
      type: 'terminal',
      sessionId: readString(root.sessionId, 'sessionId'),
      activity: parseStudioSessionActivitySnapshotValue(root.activity),
    };
  }
  if (root.type === 'error') {
    return {
      type: 'error',
      sessionId: readOptionalString(root.sessionId),
      message: readString(root.message, 'message'),
    };
  }
  if (root.type === 'activity') {
    const kind =
      root.kind === 'policy' ||
      root.kind === 'progress' ||
      root.kind === 'finding' ||
      root.kind === 'remediation' ||
      root.kind === 'terminal' ||
      root.kind === 'status'
        ? root.kind
        : null;
    if (!kind) {
      throw new Error('Invalid Studio session activity payload: kind is invalid.');
    }
    return {
      type: 'activity',
      sessionId: readString(root.sessionId, 'sessionId'),
      reviewId: readString(root.reviewId, 'reviewId'),
      passIndex: Number(root.passIndex) || 0,
      rawType: readString(root.rawType, 'rawType'),
      kind,
      label: readString(root.label, 'label'),
      detail: readString(root.detail, 'detail'),
      createdAt: root.createdAt === undefined ? null : readNullableTimestamp(root.createdAt, 'createdAt'),
      seq: root.seq === null || root.seq === undefined ? null : Number(root.seq) || 0,
      payload: asRecord(root.payload),
    };
  }

  throw new Error('Invalid Studio session activity payload: type is invalid.');
}

export function parseStudioSessionAggregateResponse(payload: unknown): StudioSessionAggregateResponse {
  const root = asRecord(payload);
  const findings = asRecord(root.findings);
  const local = asRecord(root.local);
  const capabilities = asRecord(root.capabilities);
  const paths = asRecord(root.paths);
  const adopt = asRecord(root.adopt);
  const reviewedDiff = asRecord(root.reviewedDiff);

  const unresolved = Array.isArray(findings.unresolved) ? readFindings(findings.unresolved) : [];

  return {
    session: parseReviewSessionResponseValue(root.session),
    reviews: Array.isArray(root.reviews) ? root.reviews.map((item) => parseGetReviewResponse({ review: item }).review) : [],
    latestReview:
      root.latestReview === null || root.latestReview === undefined
        ? null
        : parseGetReviewResponse({ review: root.latestReview }).review,
    activeReview:
      root.activeReview === null || root.activeReview === undefined
        ? null
        : parseGetReviewResponse({ review: root.activeReview }).review,
    findings: {
      unresolved,
      resolved: Array.isArray(findings.resolved)
        ? findings.resolved.map((item, index) => parseStudioSessionFindingRollupEntry(item, `findings.resolved[${index}]`))
        : [],
      all: Array.isArray(findings.all)
        ? findings.all.map((item, index) => parseStudioSessionFindingRollupEntry(item, `findings.all[${index}]`))
        : [],
    },
    activity: parseStudioSessionActivitySnapshotValue(root.activity),
    reviewedDiff: {
      sessionId: readString(reviewedDiff.sessionId, 'reviewedDiff.sessionId'),
      reviewId: readOptionalString(reviewedDiff.reviewId),
      available: reviewedDiff.available === true,
      status:
        reviewedDiff.status === 'available' || reviewedDiff.status === 'error' || reviewedDiff.status === 'unavailable'
          ? reviewedDiff.status
          : 'unavailable',
      reason: readOptionalString(reviewedDiff.reason),
      path: readString(reviewedDiff.path, 'reviewedDiff.path'),
      environmentRevision:
        reviewedDiff.environmentRevision === null || reviewedDiff.environmentRevision === undefined
          ? null
          : (readEnvironmentRevision(reviewedDiff.environmentRevision) ?? null),
      diff: reviewedDiff.diff === undefined ? undefined : parseWorkspaceDiffResponse(reviewedDiff.diff),
    } satisfies StudioReviewedDiffResponse,
    local: {
      environments: Array.isArray(local.environments)
        ? local.environments.map((item) => parseStudioLocalReviewEnvironment(item))
        : [],
      hasAny: local.hasAny === true,
    },
    capabilities: {
      active: capabilities.active === true,
      waitingOnHuman: capabilities.waitingOnHuman === true,
      terminal: capabilities.terminal === true,
      canShowReviewedDiff: capabilities.canShowReviewedDiff === true,
      canAdopt: capabilities.canAdopt === true,
      canListLocalEnvironments: capabilities.canListLocalEnvironments === true,
      canShowLocalDiff: capabilities.canShowLocalDiff === true,
      canMergeBack: capabilities.canMergeBack === true,
    },
    paths: {
      self: readString(paths.self, 'paths.self'),
      activity: readString(paths.activity, 'paths.activity'),
      activityEvents: readString(paths.activityEvents, 'paths.activityEvents'),
      reviewedDiff: readString(paths.reviewedDiff, 'paths.reviewedDiff'),
      localEnvironments: readString(paths.localEnvironments, 'paths.localEnvironments'),
      adopt: readString(paths.adopt, 'paths.adopt'),
    },
    adopt: {
      available: adopt.available === true,
      reason: readOptionalString(adopt.reason),
      path: readString(adopt.path, 'adopt.path'),
      modes: Array.isArray(adopt.modes)
        ? adopt.modes.filter((item): item is 'worktree' | 'branch' => item === 'worktree' || item === 'branch')
        : [],
    },
  };
}

function defaultText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function findingLocationsText(finding: ReviewFinding): string {
  if (!finding.locations.length) {
    return 'none provided';
  }

  return finding.locations
    .map((location) => {
      if (location.startLine !== null && location.endLine !== null) {
        return `${location.filePath}:${location.startLine}-${location.endLine}`;
      }
      return location.filePath;
    })
    .join(', ');
}

export function buildFindingText(finding: ReviewFinding): string {
  return [
    `Category: ${finding.category}`,
    `Pass type: ${finding.passType}`,
    `Severity: ${finding.severity}`,
    'Description:',
    finding.description,
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix, 'not provided'),
  ].join('\n');
}

export function buildFixPrompt(finding: ReviewFinding): string {
  return [
    'You are helping fix a Nimbus code review finding.',
    '',
    `Category: ${finding.category}`,
    `Pass type: ${finding.passType}`,
    `Severity: ${finding.severity}`,
    'Description:',
    finding.description,
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix, 'not provided'),
    '',
    'Please:',
    '1) Propose a minimal safe code change.',
    '2) Explain why it resolves the issue.',
    '3) List any tests to run.',
    '4) Return a patch-style diff when possible.',
  ].join('\n');
}

export function findingCount(review: ReviewResponse): number {
  if (review.summary?.findingCounts) {
    return Object.values(review.summary.findingCounts).reduce((total, value) => total + value, 0);
  }

  return review.findings.length;
}

export function statusNarrative(review: ReviewResponse): { title: string; detail: string } {
  if (review.status === 'policy_pending') {
    return {
      title: 'Policy derivation pending',
      detail: 'Nimbus is deriving an initial policy draft from session context before review execution.',
    };
  }
  if (review.status === 'policy_ready') {
    return {
      title: 'Policy ready',
      detail: 'A review policy draft is ready for confirmation and edits.',
    };
  }
  if (review.status === 'policy_approved') {
    return {
      title: 'Policy approved',
      detail: 'The approved policy is queued for review execution.',
    };
  }
  if (review.status === 'queued') {
    const retryHint = review.error?.code === 'retry_scheduled'
      ? ' A transient failure was detected and Nimbus queued an automatic retry.'
      : '';
    return {
      title: 'Queued',
      detail: `This review is waiting for an available worker slot.${retryHint}`,
    };
  }
  if (review.status === 'running') {
    return {
      title: 'Running',
      detail: 'Review analysis is in progress and findings may change until finalization completes.',
    };
  }
  if (review.status === 'failed') {
    return {
      title: 'Failed',
      detail: review.error?.message ?? 'Review failed before a full report was generated.',
    };
  }
  if (review.status === 'cancelled') {
    return {
      title: 'Cancelled',
      detail: 'Review execution was cancelled before completion.',
    };
  }
  return {
    title: 'Succeeded',
    detail: 'Review completed successfully and report output is final.',
  };
}

export function reviewFailureGuidance(review: ReviewResponse): ReviewFailureGuidance | null {
  if (review.status !== 'failed') {
    return null;
  }

  const code = review.error?.code ?? 'review_execution_failed';
  const message = review.error?.message ?? 'Review execution failed.';

  if (code.startsWith('review_context_')) {
    return {
      headline: 'Review context could not be assembled.',
      details: message,
      actions: [
        'Re-run deploy/review after ensuring the checkpoint has readable Entire session context and commit diff patch data.',
        'Confirm branch fallback metadata was passed from preflight when checkpoint context is missing.',
      ],
    };
  }

  if (message.toLowerCase().includes('invalid output') || message.toLowerCase().includes('non-authoritative fallback')) {
    return {
      headline: 'Model output failed strict V2 validation.',
      details: message,
      actions: [
        'Retry the review to get a fresh model pass.',
        'If this persists, inspect review lifecycle events for validation failures and provider output formatting issues.',
      ],
    };
  }

  if (message.toLowerCase().includes('provider') || message.toLowerCase().includes('timed out')) {
    return {
      headline: 'The analysis provider failed during execution.',
      details: message,
      actions: [
        'Retry once provider availability is restored.',
        'If worker-to-worker fetch restrictions are mentioned, enable strictly public fetch or use a service binding for the agent endpoint.',
      ],
    };
  }

  return {
    headline: 'Review execution failed.',
    details: message,
    actions: ['Retry the review and inspect review event logs if the failure repeats.'],
  };
}

export function recommendationLabel(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }

  return value.replace('_', ' ');
}

export function dateTimeLabel(value: string | null): string {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
