export type ReviewStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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

export interface ReviewResponse {
  id: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary?: ReviewSummary;
  summaryText?: string;
  furtherPassesLowYield?: boolean;
  findings: ReviewFinding[];
  evidence: ReviewEvidence[];
  provenance?: {
    contextResolution?: {
      contextResolution: 'direct' | 'branch_fallback';
      originalCheckpointId: string;
      resolvedCheckpointId: string;
      resolvedCommitSha: string;
      resolvedCommitMessage: string | null;
    };
    coChange?: {
      coChangeSkipped: boolean;
      coChangeSkipReason: string | null;
      coChangeAvailable: boolean;
      relatedFileCount: number;
    };
  };
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface GetReviewResponse {
  review: ReviewResponse;
}
