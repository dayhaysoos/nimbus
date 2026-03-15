export type ReviewStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ReviewMode = 'report_only';
export type ReviewTargetType = 'workspace_deployment';

export type ReviewSeverity = 'info' | 'critical' | 'high' | 'medium' | 'low';
export type ReviewCategory = 'security' | 'logic' | 'style' | 'breaking-change';
export type ReviewPassType = 'single' | 'security' | 'logic' | 'style' | 'breaking-change';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';

export interface ReviewFindingLocation {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewFinding {
  severity: ReviewSeverity;
  category: ReviewCategory;
  passType: ReviewPassType;
  description: string;
  locations: ReviewFindingLocation[];
  suggestedFix: string;
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

export interface ReviewContextRef {
  id: string;
  r2Key: string;
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
}

export interface ReviewFurtherPassesSignal {
  value: boolean;
  source: 'model-self-assessment';
  reliability: 'weak-signal-phase2';
}

export interface ReviewProvenanceSummary {
  sessionIds: string[];
  promptSummary: string | null;
  transcriptUrl?: string | null;
  reviewContextRef?: ReviewContextRef | null;
  reviewContextStats?: ReviewContextStats;
  coChange?: ReviewCoChangeSummary;
  contextResolution?: ReviewContextResolutionSummary;
  outputSchemaVersion?: 'v2';
  passArchitecture?: 'single';
  validation?: ReviewValidationSummary;
  furtherPassesLowYield?: ReviewFurtherPassesSignal;
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

export interface ReviewFailureGuidance {
  headline: string;
  details: string;
  actions: string[];
}
