export type ReviewStatus =
  | 'policy_pending'
  | 'policy_ready'
  | 'policy_approved'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ReviewMode = 'report_only';
export type ReviewTargetType = 'workspace_deployment';
export type ReviewSeverity = 'info' | 'critical' | 'high' | 'medium' | 'low';
export type ReviewCategory = 'security' | 'logic' | 'style' | 'breaking-change' | 'unknown';
export type ReviewPassType = 'single' | 'security' | 'logic' | 'style' | 'breaking-change' | 'unknown';
export type ReviewConfidence = 'low' | 'medium' | 'high';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';
export type ReviewBasis = 'checkpoint' | 'environment';
export type ReviewContextMode = 'basic' | 'intent_aware';

export type ReviewSessionPhase =
  | 'preparing'
  | 'reviewing'
  | 'fixing'
  | 'verifying'
  | 'waiting_on_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ReviewSessionStopReason =
  | 'initial_pass_completed'
  | 'initial_pass_failed'
  | 'followup_pass_completed'
  | 'followup_pass_failed'
  | 'diminishing_returns'
  | 'risky_fix_requires_approval'
  | 'no_safe_fixes'
  | 'no_progress'
  | 'no_progress_after_remediation'
  | 'max_repair_cycles_reached'
  | 'auto_remediation_failed'
  | 'cancelled';

export type ReviewSessionOutcomeKind =
  | 'clean'
  | 'converged_with_blockers'
  | 'blocked'
  | 'exhausted'
  | 'cancelled';

export interface ReviewEnvironmentRevision {
  source: 'workspace_head';
  diffSha256: string;
  changedFileCount: number;
  generatedAt: string;
}

export interface ReviewFindingLocation {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewFinding {
  id?: string;
  sequence?: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  passType: ReviewPassType;
  confidence?: ReviewConfidence;
  title?: string;
  description: string;
  conditions?: string | null;
  locations: ReviewFindingLocation[];
  suggestedFix: string;
  evidenceRefs?: string[];
}

export interface ReviewEvidence {
  id: string;
  type: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

export interface ReviewSummary {
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  findingCounts: Record<ReviewSeverity, number>;
  recommendation: ReviewRecommendation;
}

export interface ReviewIntentSummary {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}

export interface ReviewPolicyDraft {
  goal: string | null;
  prohibitions: string[];
  constraints: string[];
}

export interface ReviewContextRef {
  id: string;
  r2Key: string;
}

export interface ReviewedFilesSummary {
  changed: string[];
  related: string[];
  conventions: string[];
}

export interface ReviewContextStats {
  totalFilesIncluded: number;
  totalBytesIncluded: number;
  estimatedTokens: number;
  tokenBudget: number | null;
}

export interface ReviewCoChangeSummary {
  coChangeSkipped: boolean;
  coChangeSkipReason: string | null;
  coChangeAvailable: boolean;
  relatedFileCount: number;
}

export interface ReviewContextResolutionSummary {
  contextResolution: 'direct' | 'branch_fallback';
  originalCheckpointId: string;
  resolvedCheckpointId: string;
  resolvedCommitSha: string;
  resolvedCommitMessage: string | null;
}

export interface ReviewValidationSummary {
  firstPassValid: boolean;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  validationErrorCount: number;
  dedupedExactCount: number;
  fallbackApplied?: boolean;
  fallbackReason?: string | null;
  followUpReviewScore?: 1 | 2 | 3;
  followUpReviewRationale?: string;
}

export interface ReviewFurtherPassesSignal {
  value: boolean;
  source: 'model-self-assessment';
  reliability: 'weak-signal-phase2';
}

export interface ReviewProvenanceSummary {
  reviewContextMode?: ReviewContextMode;
  sessionIds: string[];
  promptSummary: string | null;
  transcriptUrl?: string | null;
  reviewContextRef?: ReviewContextRef | null;
  reviewContextStats?: ReviewContextStats;
  reviewedFiles?: ReviewedFilesSummary;
  coChange?: ReviewCoChangeSummary;
  contextResolution?: ReviewContextResolutionSummary;
  outputSchemaVersion?: 'v2';
  passArchitecture?: 'single';
  validation?: ReviewValidationSummary;
  furtherPassesLowYield?: ReviewFurtherPassesSignal;
  followUpReview?: {
    score: 1 | 2 | 3;
    rationale: string;
    source: 'model-self-assessment';
  };
  advisories?: string[];
}

export interface ReviewResponse {
  id: string;
  workspaceId: string;
  deploymentId: string;
  target: {
    type: ReviewTargetType;
    workspaceId: string;
    deploymentId: string;
  };
  mode: ReviewMode;
  status: ReviewStatus;
  idempotencyKey: string;
  attemptCount: number;
  derivedPolicy?: ReviewPolicyDraft;
  approvedPolicy?: ReviewPolicyDraft;
  approvedPolicySha256?: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary?: ReviewSummary;
  summaryText?: string;
  furtherPassesLowYield?: boolean;
  findings: ReviewFinding[];
  intent?: ReviewIntentSummary;
  evidence: ReviewEvidence[];
  provenance: ReviewProvenanceSummary;
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface GetReviewResponse {
  review: ReviewResponse;
}

export interface ReviewSessionOutcomeFindingSummary {
  severity: ReviewSeverity;
  category: ReviewCategory;
  description: string;
  filePath: string | null;
}

export interface ReviewSessionOutcomeSummary {
  kind: ReviewSessionOutcomeKind;
  summary: string | null;
  residualRisk: ReviewSeverity | null;
  recommendation: ReviewRecommendation | null;
  materializeReady: boolean;
  reviewed: {
    contextMode: ReviewContextMode | null;
    latestReviewBasis: ReviewBasis | null;
    passCount: number;
  };
  changes: {
    applied: boolean;
    remediationCount: number;
    changedFileCount: number;
    summaries: string[];
    environmentRevision: ReviewEnvironmentRevision | null;
  };
  evidence: {
    passed: number;
    failed: number;
    warning: number;
    info: number;
    highlights: ReviewEvidence[];
  };
  unresolved: {
    findingCount: number;
    highestSeverity: ReviewSeverity | null;
    highlights: ReviewSessionOutcomeFindingSummary[];
  };
}

export interface ReviewSessionPassSummary {
  reviewId: string;
  status: ReviewStatus;
  reviewBasis: ReviewBasis;
  environmentRevision?: ReviewEnvironmentRevision;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReviewSessionResponse {
  id: string;
  workspaceId: string;
  anchorDeploymentId: string;
  repo: string;
  branch: string;
  initialReviewBasis: ReviewBasis;
  anchorCommitSha: string | null;
  anchorCheckpointId: string | null;
  sourceProjectRoot: string | null;
  phase: ReviewSessionPhase;
  passCount: number;
  activeReviewId: string | null;
  latestReviewId: string | null;
  currentReviewStatus: ReviewStatus | null;
  stopReason: ReviewSessionStopReason | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  passes: ReviewSessionPassSummary[];
  outcome: ReviewSessionOutcomeSummary | null;
}

export interface GetReviewSessionResponse {
  session: ReviewSessionResponse;
}

export interface ReviewSessionListResponse {
  sessions: ReviewSessionResponse[];
}
