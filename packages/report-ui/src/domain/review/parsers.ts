import type {
  GetReviewResponse,
  GetReviewSessionResponse,
  ReviewBasis,
  ReviewCategory,
  ReviewConfidence,
  ReviewContextMode,
  ReviewEnvironmentRevision,
  ReviewFinding,
  ReviewPassType,
  ReviewPolicyDraft,
  ReviewRecommendation,
  ReviewResponse,
  ReviewSessionListResponse,
  ReviewSessionPhase,
  ReviewSessionResponse,
  ReviewSeverity,
  ReviewStatus,
} from './contracts';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid review payload: ${label} must be a non-empty string.`);
  }
  return value;
}

export function readOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function readNullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid review payload: ${label} must be a string or null.`);
  }
  return value;
}

export function readStatus(value: unknown): ReviewStatus {
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

export function readReviewBasis(value: unknown): ReviewBasis {
  if (value === 'checkpoint' || value === 'environment') {
    return value;
  }
  throw new Error('Invalid review payload: review basis is invalid.');
}

export function readContextMode(value: unknown): ReviewContextMode {
  if (value === 'basic' || value === 'intent_aware') {
    return value;
  }
  throw new Error('Invalid review payload: context mode is invalid.');
}

export function readOptionalContextMode(value: unknown): ReviewContextMode | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readContextMode(value);
}

export function readSessionPhase(value: unknown): ReviewSessionPhase {
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

function readPolicyDraft(value: unknown): ReviewPolicyDraft | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const goal = readOptionalString(record.goal);
  const normalizeLines = (input: unknown): string[] =>
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

  const prohibitions = normalizeLines(record.prohibitions);
  const constraints = normalizeLines(record.constraints);
  if (!goal && prohibitions.length === 0 && constraints.length === 0) {
    return undefined;
  }

  return {
    goal,
    prohibitions,
    constraints,
  };
}

export function readSeverity(value: unknown): ReviewSeverity {
  if (value === 'info' || value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new Error('Invalid review payload: finding severity is invalid.');
}

export function readCategory(value: unknown): ReviewCategory {
  if (value === 'security' || value === 'logic' || value === 'style' || value === 'breaking-change' || value === 'unknown') {
    return value;
  }
  throw new Error('Invalid review payload: finding category is invalid.');
}

export function readPassType(value: unknown): ReviewPassType {
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

export function readRecommendation(value: unknown): ReviewRecommendation {
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

export function readEnvironmentRevision(value: unknown): ReviewEnvironmentRevision | undefined {
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

export function readFindings(value: unknown): ReviewFinding[] {
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

export function parseReviewResponse(payload: unknown): ReviewResponse {
  const root = asRecord(payload);
  const summaryRecord = root.summary === undefined ? null : asRecord(root.summary);
  const findings = readFindings(root.findings);
  const targetRecord = asRecord(root.target);
  const provenanceRecord = asRecord(root.provenance);
  const contextResolutionRecord = asRecord(provenanceRecord.contextResolution);
  const coChangeRecord = asRecord(provenanceRecord.coChange);
  const validationRecord = asRecord(provenanceRecord.validation);
  const furtherPassesSignalRecord = asRecord(provenanceRecord.furtherPassesLowYield);
  const reviewContextRefRecord = asRecord(provenanceRecord.reviewContextRef);
  const reviewContextStatsRecord = asRecord(provenanceRecord.reviewContextStats);
  const reviewedFilesRecord = asRecord(provenanceRecord.reviewedFiles);
  const intentRecord = asRecord(root.intent);
  const errorRecord = asRecord(root.error);

  return {
    id: readString(root.id, 'review.id'),
    workspaceId: readString(root.workspaceId, 'workspaceId'),
    deploymentId: readString(root.deploymentId, 'deploymentId'),
    target: {
      type: readTargetType(targetRecord.type),
      workspaceId: readString(targetRecord.workspaceId, 'target.workspaceId'),
      deploymentId: readString(targetRecord.deploymentId, 'target.deploymentId'),
    },
    mode: readMode(root.mode),
    status: readStatus(root.status),
    idempotencyKey: readString(root.idempotencyKey, 'idempotencyKey'),
    attemptCount: Number.isInteger(root.attemptCount) ? (root.attemptCount as number) : 0,
    derivedPolicy: readPolicyDraft(root.derivedPolicy),
    approvedPolicy: readPolicyDraft(root.approvedPolicy),
    approvedPolicySha256: readOptionalString(root.approvedPolicySha256) ?? undefined,
    createdAt: readString(root.createdAt, 'createdAt'),
    updatedAt: readString(root.updatedAt, 'updatedAt'),
    startedAt: readNullableTimestamp(root.startedAt, 'startedAt'),
    finishedAt: readNullableTimestamp(root.finishedAt, 'finishedAt'),
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
    summaryText: typeof root.summaryText === 'string' ? root.summaryText : undefined,
    furtherPassesLowYield: typeof root.furtherPassesLowYield === 'boolean' ? root.furtherPassesLowYield : undefined,
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
    evidence: readEvidenceList(root.evidence),
    provenance: {
      sessionIds: Array.isArray(provenanceRecord.sessionIds)
        ? provenanceRecord.sessionIds.filter((item): item is string => typeof item === 'string')
        : [],
      promptSummary: readOptionalString(provenanceRecord.promptSummary),
      transcriptUrl: readOptionalString(provenanceRecord.transcriptUrl) ?? undefined,
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
                validationRecord.fallbackApplied === undefined ? undefined : validationRecord.fallbackApplied === true,
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
    markdownSummary: root.markdownSummary === null ? null : readString(root.markdownSummary, 'markdownSummary'),
    error:
      Object.keys(errorRecord).length > 0
        ? {
            code: readString(errorRecord.code, 'error.code'),
            message: readString(errorRecord.message, 'error.message'),
          }
        : undefined,
  };
}

export function parseGetReviewResponse(payload: unknown): GetReviewResponse {
  const root = asRecord(payload);
  const review = asRecord(root.review);
  if (!root.review || Object.keys(review).length === 0) {
    throw new Error('No review payload in response.');
  }
  return {
    review: parseReviewResponse(review),
  };
}

export function parseReviewSessionResponse(value: unknown): ReviewSessionResponse {
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
    session: parseReviewSessionResponse(root.session),
  };
}

export function parseListReviewSessionsResponse(payload: unknown): ReviewSessionListResponse {
  const root = asRecord(payload);
  if (!Array.isArray(root.sessions)) {
    throw new Error('Invalid review session payload: sessions must be an array.');
  }
  return {
    sessions: root.sessions.map((item) => parseReviewSessionResponse(item)),
  };
}
