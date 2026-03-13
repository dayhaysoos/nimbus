export type ReviewStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewConfidence = 'high' | 'medium' | 'low';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';

export interface ReviewFindingLocation {
  path: string;
  line: number;
}

export interface ReviewSuggestedFix {
  kind: 'text';
  value: string;
}

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  title: string;
  description: string;
  conditions: string | null;
  locations: ReviewFindingLocation[];
  suggestedFix: ReviewSuggestedFix | null;
  evidenceRefs: string[];
}

export interface ReviewEvidence {
  id: string;
  type: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

export interface ReviewSummary {
  riskLevel: ReviewSeverity;
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
  findings: ReviewFinding[];
  evidence: ReviewEvidence[];
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface GetReviewResponse {
  review: ReviewResponse;
}
