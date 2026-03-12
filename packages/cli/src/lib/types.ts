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
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  eventsUrl: string;
}

export interface WorkspaceCreateResponse {
  workspace: WorkspaceResponse;
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

export type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewConfidence = 'high' | 'medium' | 'low';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';

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
  target: {
    type: 'workspace_deployment';
    workspaceId: string;
    deploymentId: string;
  };
  mode: 'report_only';
  status: ReviewRunStatus;
  idempotencyKey: string;
  attemptCount: number;
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
    sessionIds: string[];
    promptSummary: string | null;
    transcriptUrl?: string | null;
  };
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
}

export interface ReviewCreateResponse {
  reviewId: string;
  status: ReviewRunStatus;
  eventsUrl: string;
  resultUrl: string;
}

export interface ReviewGetResponse {
  review: ReviewRunResponse;
}

export interface ReviewEventEnvelope {
  id: string | null;
  data: Record<string, unknown>;
}
