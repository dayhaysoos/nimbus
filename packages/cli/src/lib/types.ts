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
