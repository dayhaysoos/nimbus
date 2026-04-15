// Job status type
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

// Job phase type
export type JobPhase =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'building'
  | 'repairing'
  | 'validating'
  | 'deploying'
  | 'completed'
  | 'failed'
  | 'cancelled';

// Job response from API
export interface JobResponse {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  phase: JobPhase;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  previewUrl: string | null;
  deployedUrl: string | null;
  errorMessage: string | null;
  fileCount: number | null;

  sourceType?: string | null;
  checkpointId?: string | null;
  commitSha?: string | null;
  sourceRef?: string | null;
  sourceBundleKey?: string | null;
  sourceBundleSha256?: string | null;
  sourceBundleBytes?: number | null;
}

// Job list item (lightweight)
export interface JobListItem {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  phase?: JobPhase;
  createdAt: string;
  deployedUrl: string | null;
}

// Jobs list response
export interface JobsListResponse {
  jobs: JobListItem[];
}

export interface CheckpointJobCreateResponse {
  jobId: string;
  status: JobStatus;
  phase: JobPhase;
  eventsUrl: string;
  jobUrl: string;
}

export type WorkspaceStatus = 'creating' | 'ready' | 'failed' | 'deleted';

export interface WorkspaceResponse {
  id: string;
  status: WorkspaceStatus;
  sourceType: string;
  checkpointId: string | null;
  commitSha: string;
  sourceRef: string | null;
  sourceProjectRoot: string | null;
  sourceBundleKey: string;
  sourceBundleSha256: string;
  sourceBundleBytes: number;
  sandboxId: string;
  baselineReady: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  lastDeploymentId?: string | null;
  lastDeploymentStatus?: WorkspaceDeploymentStatus | null;
  lastDeployedUrl?: string | null;
  lastDeployedAt?: string | null;
  lastDeploymentErrorCode?: string | null;
  lastDeploymentErrorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  eventsUrl: string;
}

export interface WorkspaceCreateResponse {
  workspace: WorkspaceResponse;
  reused?: boolean;
}

export interface WorkspaceResetResponse {
  workspace: WorkspaceResponse;
  warning?: string;
}

export interface WorkspaceFileListEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface WorkspaceFileListResponse {
  workspaceId: string;
  path: string;
  entries: WorkspaceFileListEntry[];
}

export interface WorkspaceFileResponse {
  workspaceId: string;
  path: string;
  sizeBytes: number | null;
  maxBytes: number;
  truncated: boolean;
  content: string;
}

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

export type WorkspaceOperationType = 'export_zip' | 'export_patch' | 'fork_github';
export type WorkspaceOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface WorkspaceOperationResponse {
  id: string;
  type: WorkspaceOperationType;
  status: WorkspaceOperationStatus;
  workspaceId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  warnings?: unknown[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface WorkspaceOperationCreateResponse {
  operation: WorkspaceOperationResponse;
}

export interface WorkspaceArtifactDownload {
  url: string;
  expiresAt: string;
}

export type WorkspaceArtifactType = 'zip' | 'patch';
export type WorkspaceArtifactStatus = 'available' | 'expired';

export interface WorkspaceArtifactResponse {
  id: string;
  type: WorkspaceArtifactType;
  status: WorkspaceArtifactStatus;
  bytes: number;
  contentType: string;
  sha256: string;
  workspaceId: string;
  sourceBaselineSha: string;
  creatorId: string | null;
  createdAt: string;
  expiresAt: string;
  warnings: unknown[];
  metadata: Record<string, unknown>;
  download?: WorkspaceArtifactDownload | null;
}

export interface WorkspaceArtifactListResponse {
  artifacts: WorkspaceArtifactResponse[];
}

export type WorkspaceDeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkspaceToolchainProfile {
  manager: 'pnpm' | 'yarn' | 'npm' | 'unknown';
  version: string | null;
  detectedFrom: 'packageManager' | 'lockfile' | 'scripts' | 'fallback' | 'request';
  projectRoot: string;
  lockfile: {
    name: string;
    sha256: string;
  } | null;
}

export interface WorkspaceDeploymentRemediation {
  code: string;
  applied: boolean;
  details?: string;
}

export interface WorkspaceDeploymentResponse {
  id: string;
  workspaceId: string;
  status: WorkspaceDeploymentStatus;
  provider: string;
  idempotencyKey: string;
  maxRetries: number;
  attemptCount: number;
  sourceSnapshotSha256: string | null;
  sourceBundleKey: string | null;
  deployedUrl: string | null;
  providerDeploymentId: string | null;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  provenance: Record<string, unknown>;
  toolchain: WorkspaceToolchainProfile | null;
  dependencyCacheKey: string | null;
  dependencyCacheHit: boolean;
  remediations: WorkspaceDeploymentRemediation[];
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface WorkspaceDeploymentCreateResponse {
  deployment: WorkspaceDeploymentResponse;
  reused?: boolean;
}

export interface WorkspaceDeploymentGetResponse {
  deployment: WorkspaceDeploymentResponse;
  nextAction?: string | null;
}

export interface WorkspaceDeploymentPreflightCheck {
  code: string;
  ok: boolean;
  details?: string;
}

export interface WorkspaceDeploymentPreflightResponse {
  preflight: {
    ok: boolean;
    toolchain: WorkspaceToolchainProfile | null;
    checks: WorkspaceDeploymentPreflightCheck[];
    remediations: WorkspaceDeploymentRemediation[];
  };
  nextAction?: string | null;
}

export interface DeployReadinessCheck {
  code: string;
  ok: boolean;
  details?: string;
}

export interface DeployReadinessResponse {
  ok: boolean;
  checks: DeployReadinessCheck[];
}

export interface ReviewReadinessResponse {
  ok: boolean;
  checks: DeployReadinessCheck[];
}

export type ReviewRunStatus =
  | 'policy_pending'
  | 'policy_ready'
  | 'policy_approved'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type ReviewPolicyMode = 'none' | 'auto' | 'review';
export type ReviewBasis = 'checkpoint' | 'environment';
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewConfidence = 'high' | 'medium' | 'low';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';
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

export interface ReviewSessionOutcomeFindingSummary {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  category: 'security' | 'logic' | 'style' | 'breaking-change';
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
    contextMode: 'basic' | 'intent_aware' | null;
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
    highlights: ReviewEvidenceItem[];
  };
  unresolved: {
    findingCount: number;
    highestSeverity: 'info' | 'low' | 'medium' | 'high' | 'critical' | null;
    highlights: ReviewSessionOutcomeFindingSummary[];
  };
}

export interface ReviewEnvironmentRevision {
  source: 'workspace_head';
  diffSha256: string;
  changedFileCount: number;
  generatedAt: string;
}

export interface ReviewSummary {
  riskLevel: ReviewSeverity;
  findingCounts: Record<ReviewSeverity, number>;
  recommendation: ReviewRecommendation;
}

export interface ReviewFindingLocation {
  path: string;
  line: number;
}

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  title: string;
  description: string;
  conditions: string | null;
  locations: ReviewFindingLocation[];
  suggestedFix: {
    kind: 'text';
    value: string;
  } | null;
  evidenceRefs: string[];
}

export interface ReviewEvidenceItem {
  id: string;
  type: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

export interface ReviewRunResponse {
  id: string;
  workspaceId: string;
  deploymentId: string;
  sessionId: string | null;
  target: {
    type: 'workspace_deployment';
    workspaceId: string;
    deploymentId: string;
  };
  mode: 'report_only';
  status: ReviewRunStatus;
  policyMode?: ReviewPolicyMode;
  reviewBasis?: ReviewBasis;
  idempotencyKey: string;
  attemptCount: number;
  derivedPolicy?: {
    goal: string | null;
    prohibitions: string[];
    constraints: string[];
  };
  approvedPolicy?: {
    goal: string | null;
    prohibitions: string[];
    constraints: string[];
  };
  approvedPolicySha256?: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary?: ReviewSummary;
  findings: ReviewFinding[];
  intent?: {
    goal: string | null;
    constraints: string[];
    decisions: string[];
  };
  evidence: ReviewEvidenceItem[];
  provenance: {
    repo: string;
    branch: string;
    reviewContextMode?: 'basic' | 'intent_aware';
    reviewContextRef?: {
      id: string;
      r2Key: string;
    } | null;
    sessionIds: string[];
    policyItems: string[];
    environmentRevision?: ReviewEnvironmentRevision;
    rawSessionPrompts?: string | null;
    intentSummary?: {
      goal: string | null;
      prohibitions: string[];
      constraints: string[];
    };
    promptSummary: string | null;
    transcriptUrl?: string | null;
    checkpointSelectionMode?: 'latest' | 'last_n' | 'range';
    includedCheckpoints?: Array<{
      checkpointId: string;
      commitSha: string;
      commitSubject: string;
    }>;
  };
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
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
  currentReviewStatus: ReviewRunStatus | null;
  stopReason: ReviewSessionStopReason | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  passes: Array<{
    reviewId: string;
    status: ReviewRunStatus;
    reviewBasis: ReviewBasis;
    environmentRevision?: ReviewEnvironmentRevision;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  outcome: ReviewSessionOutcomeSummary | null;
}

export interface ReviewCreateResponse {
  reviewId: string;
  sessionId?: string | null;
  status: ReviewRunStatus;
  eventsUrl: string;
  resultUrl: string;
  sessionUrl?: string;
}

export interface ReviewPolicyDeriveResponse {
  reviewId: string;
  sessionId?: string | null;
  status: ReviewRunStatus;
  derivedPolicy: {
    goal: string | null;
    prohibitions: string[];
    constraints: string[];
  };
  sessionUrl?: string;
}

export interface ReviewPolicyApproveResponse {
  reviewId: string;
  approvedPolicySha256: string;
}

export interface ReviewPolicyResponse {
  policy: {
    goal: string | null;
    prohibitions: string[];
    constraints: string[];
  };
  source: 'model_or_fallback' | 'empty';
}

export interface ReviewGetResponse {
  review: ReviewRunResponse;
  session?: ReviewSessionResponse;
}

export interface ReviewSessionGetResponse {
  session: ReviewSessionResponse;
}

export interface ReviewSessionListResponse {
  sessions: ReviewSessionResponse[];
}

export interface ReviewContextSnapshotFile {
  path: string;
  content: string;
  byteSize: number;
  source: 'changed' | 'related' | 'convention';
}

export interface ReviewContextSnapshot {
  retrieval?: {
    changedFiles?: ReviewContextSnapshotFile[];
  };
}

export interface ReviewContextGetResponse {
  context: ReviewContextSnapshot;
}

export interface ReviewEventEnvelope {
  id: string | null;
  data: Record<string, unknown>;
}

export interface AdminApiKeyCreateResponse {
  key: string;
  accountId: string;
  label: string;
  isAdmin: boolean;
}

export interface RepoRegisterResponse {
  repoSlug: string;
  accountId: string;
  status: 'registered' | 'already_registered';
}

export interface AuthExchangeResponse {
  token: string;
  expiresInSeconds: number;
}

export interface AuthExchangeHealthResponse {
  exchangeReady: boolean;
  tokenSecretConfigured: boolean;
  oidcCacheBindingConfigured: boolean;
  oidcCacheWarm: boolean | null;
  jwksCacheTtlSeconds: number;
  tokenTtlSeconds: number;
}
