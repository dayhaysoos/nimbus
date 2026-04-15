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

export interface ReviewHistoryItem {
  id: string;
  workspaceId: string;
  deploymentId: string;
  repo: string;
  branch: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  findingCount: number | null;
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | null;
  recommendation: ReviewRecommendation | null;
  summaryText: string | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface ListReviewsResponse {
  reviews: ReviewHistoryItem[];
}

export interface StudioContextResponse {
  repo: string | null;
  branch: string | null;
  detectedAt: string;
}

export type StudioPolicyMode = 'auto' | 'review';

export interface StudioNewReviewPreflightCheck {
  code: 'checkpoint' | 'entire_context';
  label: string;
  ok: boolean;
  detail: string;
}

export type StudioPreflightIssueCode =
  | 'checkpoint_unavailable'
  | 'checkpoint_missing_trailer'
  | 'entire_context_unavailable'
  | 'branch_context_changed'
  | 'unknown';

export interface StudioPreflightIssue {
  code: StudioPreflightIssueCode;
  message: string;
}

export interface StudioNewReviewPreflightCapabilities {
  canStart: boolean;
  canStartInBasicMode: boolean;
  canStartInIntentAwareMode: boolean;
  canReviewPolicy: boolean;
}

export interface StudioNewReviewPreflightResponse {
  repo: string | null;
  branch: string | null;
  policyMode: StudioPolicyMode;
  startability: 'blocked' | 'basic' | 'intent_aware';
  contextMode: ReviewContextMode;
  requestedLastCheckpoints: 1 | 2 | 3;
  effectiveLastCheckpoints: 1 | 2 | 3;
  lastCheckpoints: 1 | 2 | 3;
  checkpointSelectionMode: 'latest' | 'last_n';
  checkpointId: string | null;
  commitSha: string | null;
  includedCheckpoints: Array<{
    checkpointId: string;
    commitSha: string;
    commitSubject: string;
  }>;
  ready: boolean;
  capabilities: StudioNewReviewPreflightCapabilities;
  blockingIssues: StudioPreflightIssue[];
  warnings: StudioPreflightIssue[];
  checks: StudioNewReviewPreflightCheck[];
  error?: {
    code: StudioPreflightIssueCode;
    message: string;
  };
}

export interface StudioNewReviewStartResponse {
  reviewId: string;
  sessionId: string | null;
  routePath: string;
  policyMode: StudioPolicyMode;
  contextMode: ReviewContextMode;
  requestedLastCheckpoints: 1 | 2 | 3;
  effectiveLastCheckpoints: 1 | 2 | 3;
  status: 'policy_ready' | 'queued';
}

export type StudioNewReviewStartStage =
  | 'checkpoint'
  | 'entire_context'
  | 'cochange'
  | 'workspace'
  | 'deployment'
  | 'review_creation'
  | 'policy';

export interface StudioNewReviewStartStageEvent {
  type: 'stage';
  stage: StudioNewReviewStartStage;
  state: 'active' | 'completed';
  label: string;
  detail: string;
}

export interface StudioNewReviewStartCompletedEvent extends StudioNewReviewStartResponse {
  type: 'completed';
  detail: string;
}

export interface StudioNewReviewStartErrorEvent {
  type: 'error';
  message: string;
}

export type StudioNewReviewStartStreamEvent =
  | StudioNewReviewStartStageEvent
  | StudioNewReviewStartCompletedEvent
  | StudioNewReviewStartErrorEvent;

export type WorkspaceDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceDiffFile {
  path: string;
  status: WorkspaceDiffStatus;
  previousPath?: string;
}

export interface WorkspaceDiffResponse {
  workspaceId: string;
  includePatch: boolean;
  maxBytes: number;
  truncated: boolean;
  changedFilesTruncated?: boolean;
  patchTruncated?: boolean;
  summaryIsPartial?: boolean;
  summary: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    totalChanged: number;
  };
  changedFiles: WorkspaceDiffFile[];
  changedFilesBytes?: number;
  changedFilesTotalBytes?: number;
  patch?: string;
  patchBytes?: number;
  patchTotalBytes?: number;
}

export interface LocalReviewEnvironment {
  sessionId: string;
  repoRoot: string;
  repo: string | null;
  branchName: string;
  mode: 'worktree' | 'branch';
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  environmentRevision: ReviewEnvironmentRevision;
  contextMode: ReviewContextMode | 'unknown';
  materializedAt: string;
  enterCommand: string;
}

export interface LocalReviewEnvironmentListResponse {
  environments: LocalReviewEnvironment[];
}

export interface LocalReviewEnvironmentDiffResponse {
  entry: LocalReviewEnvironment;
  baseRef: string;
  diff: string;
  hasDiff: boolean;
  enterCommand: string;
}

export interface LocalReviewEnvironmentMergeBackResponse {
  sessionId: string;
  currentBranch: string;
  sourceBranch: string;
  sourceCommit: string;
  newHead: string | null;
  worktreePath: string | null;
  status: 'applied' | 'already_applied';
}

export interface StudioSessionActivitySnapshot {
  sessionId: string;
  phase: ReviewSessionPhase;
  state: 'active' | 'waiting_on_human' | 'terminal';
  currentReviewStatus: ReviewStatus | null;
  activeReviewId: string | null;
  latestReviewId: string | null;
  passCount: number;
  summary: string;
  detail: string;
  canStream: boolean;
  streamPath: string;
  updatedAt: string;
}

export interface StudioSessionActivitySnapshotResponse {
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityEntry {
  type: 'activity';
  sessionId: string;
  reviewId: string;
  passIndex: number;
  rawType: string;
  kind: 'policy' | 'progress' | 'finding' | 'remediation' | 'terminal' | 'status';
  label: string;
  detail: string;
  createdAt: string | null;
  seq: number | null;
  payload: Record<string, unknown>;
}

export interface StudioSessionActivityStreamSnapshotEvent {
  type: 'snapshot';
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityStreamTerminalEvent {
  type: 'terminal';
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityStreamErrorEvent {
  type: 'error';
  sessionId?: string | null;
  message: string;
}

export type StudioSessionActivityEvent =
  | StudioSessionActivityStreamSnapshotEvent
  | StudioSessionActivityEntry
  | StudioSessionActivityStreamTerminalEvent
  | StudioSessionActivityStreamErrorEvent;

export interface StudioSessionFindingRollupEntry {
  finding: ReviewFinding;
  state: 'resolved' | 'unresolved';
  firstSeenReviewId: string;
  lastSeenReviewId: string;
  reviewIds: string[];
}

export interface StudioLocalReviewEnvironment extends LocalReviewEnvironment {
  diffPath: string;
  mergeBackPath: string;
}

export interface StudioReviewedDiffResponse {
  sessionId: string;
  reviewId: string | null;
  available: boolean;
  status: 'available' | 'unavailable' | 'error';
  reason: string | null;
  path: string;
  environmentRevision: ReviewEnvironmentRevision | null;
  diff?: WorkspaceDiffResponse;
}

export interface StudioSessionAggregateResponse {
  session: ReviewSessionResponse;
  reviews: ReviewResponse[];
  latestReview: ReviewResponse | null;
  activeReview: ReviewResponse | null;
  findings: {
    unresolved: ReviewFinding[];
    resolved: StudioSessionFindingRollupEntry[];
    all: StudioSessionFindingRollupEntry[];
  };
  activity: StudioSessionActivitySnapshot;
  reviewedDiff: StudioReviewedDiffResponse;
  local: {
    environments: StudioLocalReviewEnvironment[];
    hasAny: boolean;
  };
  capabilities: {
    active: boolean;
    waitingOnHuman: boolean;
    terminal: boolean;
    canShowReviewedDiff: boolean;
    canAdopt: boolean;
    canListLocalEnvironments: boolean;
    canShowLocalDiff: boolean;
    canMergeBack: boolean;
  };
  paths: {
    self: string;
    activity: string;
    activityEvents: string;
    reviewedDiff: string;
    localEnvironments: string;
    adopt: string;
  };
  adopt: {
    available: boolean;
    reason: string | null;
    path: string;
    modes: Array<'worktree' | 'branch'>;
  };
}

export interface ReviewFailureGuidance {
  headline: string;
  details: string;
  actions: string[];
}
