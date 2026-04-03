import type {
  GetReviewResponse,
  ListReviewsResponse,
  ReviewCategory,
  ReviewFailureGuidance,
  ReviewFinding,
  ReviewHistoryItem,
  ReviewPassType,
  ReviewRecommendation,
  ReviewResponse,
  ReviewSeverity,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartResponse,
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
  if (value === 'security' || value === 'logic' || value === 'style' || value === 'breaking-change') {
    return value;
  }
  throw new Error('Invalid review payload: finding category is invalid.');
}

function readPassType(value: unknown): ReviewPassType {
  if (value === 'single' || value === 'security' || value === 'logic' || value === 'style' || value === 'breaking-change') {
    return value;
  }
  throw new Error('Invalid review payload: finding passType is invalid.');
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

export function parseGetReviewResponse(payload: unknown): GetReviewResponse {
  const root = asRecord(payload);
  const review = asRecord(root.review);
  if (!root.review || Object.keys(review).length === 0) {
    throw new Error('No review payload in response.');
  }

  const summaryRecord = review.summary === undefined ? null : asRecord(review.summary);
  const findings = Array.isArray(review.findings)
    ? review.findings.map((item) => {
        const finding = asRecord(item);
        const locations = Array.isArray(finding.locations)
          ? finding.locations.map((locationItem) => {
              const location = asRecord(locationItem);
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

        return {
          severity: readSeverity(finding.severity),
          category: readCategory(finding.category),
          passType: readPassType(finding.passType),
          description: readString(finding.description, 'finding description'),
          locations,
          suggestedFix: typeof finding.suggestedFix === 'string' ? finding.suggestedFix : '',
        };
      })
    : [];

  const targetRecord = asRecord(review.target);
  const provenanceRecord = asRecord(review.provenance);
  const contextResolutionRecord = asRecord(provenanceRecord.contextResolution);
  const coChangeRecord = asRecord(provenanceRecord.coChange);
  const validationRecord = asRecord(provenanceRecord.validation);
  const furtherPassesSignalRecord = asRecord(provenanceRecord.furtherPassesLowYield);
  const reviewContextRefRecord = asRecord(provenanceRecord.reviewContextRef);
  const reviewContextStatsRecord = asRecord(provenanceRecord.reviewContextStats);
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
  if (root.checkpointId !== null && root.checkpointId !== undefined && typeof root.checkpointId !== 'string') {
    throw new Error('Invalid Studio preflight payload: checkpointId must be a string or null.');
  }
  if (root.commitSha !== null && root.commitSha !== undefined && typeof root.commitSha !== 'string') {
    throw new Error('Invalid Studio preflight payload: commitSha must be a string or null.');
  }
  if (typeof root.ready !== 'boolean') {
    throw new Error('Invalid Studio preflight payload: ready must be boolean.');
  }
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

  const errorRecord = asRecord(root.error);
  const error =
    Object.keys(errorRecord).length > 0
      ? {
          code: (
            errorRecord.code === 'checkpoint_unavailable' ||
            errorRecord.code === 'entire_context_unavailable' ||
            errorRecord.code === 'unknown'
              ? errorRecord.code
              : 'unknown'
          ) as 'checkpoint_unavailable' | 'entire_context_unavailable' | 'unknown',
          message: readString(errorRecord.message, 'error.message'),
        }
      : undefined;

  return {
    repo: typeof repo === 'string' ? repo : null,
    branch: typeof branch === 'string' ? branch : null,
    policyMode: root.policyMode,
    checkpointId: typeof root.checkpointId === 'string' ? root.checkpointId : null,
    commitSha: typeof root.commitSha === 'string' ? root.commitSha : null,
    ready: root.ready,
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

  return {
    reviewId,
    routePath,
    policyMode: root.policyMode,
    status: root.status,
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
