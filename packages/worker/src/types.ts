import type { Sandbox } from '@cloudflare/sandbox';

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ReviewRunner?: DurableObjectNamespace;
  DB: D1Database;
  SOURCE_BUNDLES?: R2Bucket;
  WORKSPACE_ARTIFACTS?: R2Bucket;
  REVIEW_CONTEXTS?: R2Bucket;
  CHECKPOINT_JOBS_QUEUE?: Queue;

  // Runtime flag defaults (can be overridden by D1 runtime_flags)
  V2_ENABLED?: string;
  V2_CODE_BROWSER_ENABLED?: string;
  MAX_ATTEMPTS?: string;
  ATTEMPT_TIMEOUT_MS?: string;
  TOTAL_TIMEOUT_MS?: string;
  IDEMPOTENCY_TTL_HOURS?: string;
  MAX_REPAIR_CYCLES?: string;
  LINT_BLOCKING?: string;
  TEST_BLOCKING?: string;
  SAFE_INSTALL_IGNORE_SCRIPTS?: string;
  AUTO_INSTALL_SCRIPTS_FALLBACK?: string;
  RAW_RETENTION_DAYS?: string;
  SUMMARY_RETENTION_DAYS?: string;
  WORKSPACE_AGENT_RUNTIME_ENABLED?: string;
  WORKSPACE_AGENT_MAX_RETRIES?: string;
  WORKSPACE_AGENT_MAX_STEPS?: string;
  WORKSPACE_AGENT_TIMEOUT_MS?: string;
  WORKSPACE_AGENT_ALLOW_SCRIPTED_PROVIDER?: string;
  WORKSPACE_DEPLOY_ENABLED?: string;
  WORKSPACE_DEPLOY_PROVIDER?: string;
  WORKSPACE_DEPLOY_BASE_URL?: string;
  WORKSPACE_DEPLOY_REAL_PROVIDER_ENABLED?: string;
  WORKSPACE_DEPLOY_PREVIEW_DOMAIN?: string;
  WORKSPACE_DEPLOY_PROJECT_NAME?: string;
  WORKSPACE_DEPLOY_PROVIDER_MAX_POLLS?: string;
  WORKSPACE_DEPLOY_PROVIDER_POLL_INTERVAL_MS?: string;
  WORKSPACE_DEPLOY_FORCE_INLINE?: string;
  WORKSPACE_DEPLOY_ALLOW_PROJECT_TOOL_MISSING?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;

  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_JWT?: string;
  GITHUB_API_BASE_URL?: string;
  GITHUB_FORK_ALLOWED_ORGS?: string;
  BLOCK_ON_SECRET_MATCH?: string;
  WORKSPACE_ARTIFACT_DOWNLOAD_SECRET?: string;

  WORKSPACE_TASKS_QUEUE?: Queue;
  WORKSPACE_DEPLOYS_QUEUE?: Queue;
  REVIEWS_QUEUE?: Queue;

  AGENT_PROVIDER?: string;
  AGENT_MODEL?: string;
  REVIEW_MODEL?: string;
  AGENT_SDK_URL?: string;
  AGENT_SDK_AUTH_TOKEN?: string;
  AGENT_ENDPOINT?: Fetcher;
  REVIEW_AGENT_MAX_STEPS?: string;
  REVIEW_AGENT_MAX_FILE_BYTES?: string;
  REVIEW_CONTEXT_REPO?: string;
  REVIEW_CONTEXT_GITHUB_TOKEN?: string;
  REVIEW_CONTEXT_DEFAULT_TOKEN_BUDGET?: string;
  NIMBUS_HOSTED?: string;
}

export interface AuthContext {
  accountId: string;
  isAdmin: boolean;
  isAuthenticated: boolean;
  isHostedMode: boolean;
}

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

// Job record from D1 database
export interface JobRecord {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  phase?: JobPhase;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at?: string | null;
  cancelled_at?: string | null;
  preview_url: string | null;
  deployed_url: string | null;
  code_url?: string | null;
  code_zip_url?: string | null;
  error_message: string | null;
  error_code?: string | null;
  file_count: number | null;
  current_attempt?: number;
  retry_count?: number;

  source_type?: string | null;
  checkpoint_id?: string | null;
  commit_sha?: string | null;
  source_ref?: string | null;
  source_project_root?: string | null;
  build_run_tests_if_present?: number | null;
  build_run_lint_if_present?: number | null;
  source_bundle_key?: string | null;
  source_bundle_sha256?: string | null;
  source_bundle_bytes?: number | null;
}

// Job response for API (camelCase)
export interface JobResponse {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  phase: JobPhase;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt?: string | null;
  cancelledAt?: string | null;
  previewUrl: string | null;
  deployedUrl: string | null;
  codeUrl?: string | null;
  codeZipUrl?: string | null;
  errorMessage: string | null;
  errorCode?: string | null;
  fileCount: number | null;
  currentAttempt?: number;
  retryCount?: number;

  sourceType?: string | null;
  checkpointId?: string | null;
  commitSha?: string | null;
  sourceRef?: string | null;
  sourceProjectRoot?: string | null;
  buildRunTestsIfPresent?: boolean | null;
  buildRunLintIfPresent?: boolean | null;
  sourceBundleKey?: string | null;
  sourceBundleSha256?: string | null;
  sourceBundleBytes?: number | null;
}

// Job list item (lightweight for listing)
export interface JobListItem {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  phase?: JobPhase;
  createdAt: string;
  deployedUrl: string | null;
}

export interface RuntimeFlags {
  v2Enabled: boolean;
  v2CodeBrowserEnabled: boolean;
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  idempotencyTtlHours: number;
  maxRepairCycles: number;
  lintBlocking: boolean;
  testBlocking: boolean;
  safeInstallIgnoreScripts: boolean;
  autoInstallScriptsFallback: boolean;
  rawRetentionDays: number;
  summaryRetentionDays: number;
  workspaceAgentRuntimeEnabled: boolean;
  workspaceDeployEnabled: boolean;
}

export type WorkspacePackageManager = 'pnpm' | 'yarn' | 'npm' | 'unknown';
export type WorkspaceToolchainDetectedFrom = 'packageManager' | 'lockfile' | 'scripts' | 'fallback' | 'request';

export interface WorkspaceToolchainLockfile {
  name: string;
  sha256: string;
}

export interface WorkspaceToolchainProfile {
  manager: WorkspacePackageManager;
  version: string | null;
  detectedFrom: WorkspaceToolchainDetectedFrom;
  projectRoot: string;
  lockfile: WorkspaceToolchainLockfile | null;
}

export interface WorkspaceDeploymentRemediation {
  code: string;
  applied: boolean;
  details?: string;
}

export type WorkspaceStatus = 'creating' | 'ready' | 'failed' | 'deleted';

export interface WorkspaceRecord {
  id: string;
  status: WorkspaceStatus;

  source_type: string;
  checkpoint_id: string | null;
  commit_sha: string;
  source_ref: string | null;
  source_project_root: string | null;

  source_bundle_key: string;
  source_bundle_sha256: string;
  source_bundle_bytes: number;

  sandbox_id: string;
  baseline_ready: number;

  error_code: string | null;
  error_message: string | null;

  last_deployment_id: string | null;
  last_deployment_status: string | null;
  last_deployed_url: string | null;
  last_deployed_at: string | null;
  last_deployment_error_code: string | null;
  last_deployment_error_message: string | null;

  last_event_seq: number;

  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

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

  lastDeploymentId: string | null;
  lastDeploymentStatus: WorkspaceDeploymentStatus | null;
  lastDeployedUrl: string | null;
  lastDeployedAt: string | null;
  lastDeploymentErrorCode: string | null;
  lastDeploymentErrorMessage: string | null;

  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;

  eventsUrl: string;
}

export type WorkspaceOperationType = 'export_zip' | 'export_patch' | 'fork_github';
export type WorkspaceOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface WorkspaceOperationRecord {
  id: string;
  workspace_id: string;
  type: WorkspaceOperationType;
  status: WorkspaceOperationStatus;
  actor_id: string | null;
  auth_principal_json: string;
  request_payload_json: string;
  request_payload_sha256: string;
  idempotency_key: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  result_json: string | null;
  warnings_json: string;
  error_code: string | null;
  error_class: string | null;
  error_message: string | null;
  error_details_json: string | null;
  created_at: string;
  updated_at: string;
}

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

export type WorkspaceArtifactType = 'zip' | 'patch';
export type WorkspaceArtifactStatus = 'available' | 'expired';

export interface WorkspaceArtifactRecord {
  id: string;
  workspace_id: string;
  operation_id: string | null;
  type: WorkspaceArtifactType;
  status: WorkspaceArtifactStatus;
  object_key: string;
  bytes: number;
  content_type: string;
  sha256: string;
  source_baseline_sha: string;
  creator_id: string | null;
  retention_expires_at: string;
  expired_at: string | null;
  warnings_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

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
  metadata: unknown;
}

export type WorkspaceTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkspaceTaskRecord {
  id: string;
  workspace_id: string;
  status: WorkspaceTaskStatus;
  prompt: string;
  provider: string;
  model: string;
  idempotency_key: string;
  request_payload_json: string;
  request_payload_sha256: string;
  max_steps: number;
  max_retries: number;
  attempt_count: number;
  actor_id: string | null;
  tool_policy_json: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceTaskResponse {
  id: string;
  workspaceId: string;
  status: WorkspaceTaskStatus;
  prompt: string;
  provider: string;
  model: string;
  idempotencyKey: string;
  maxSteps: number;
  maxRetries: number;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export type WorkspaceDeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkspaceDeploymentRecord {
  id: string;
  workspace_id: string;
  status: WorkspaceDeploymentStatus;
  provider: string;
  idempotency_key: string;
  request_payload_json: string;
  request_payload_sha256: string;
  max_retries: number;
  attempt_count: number;
  source_snapshot_sha256: string | null;
  source_bundle_key: string | null;
  provenance_json: string;
  provider_deployment_id: string | null;
  deployed_url: string | null;
  last_event_seq: number;
  cancel_requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  result_json: string | null;
  toolchain_json: string | null;
  dependency_cache_key: string | null;
  dependency_cache_hit: number;
  remediations_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
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

export type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ReviewTargetType = 'workspace_deployment';
export type ReviewMode = 'report_only';
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ReviewConfidence = 'high' | 'medium' | 'low';
export type ReviewRecommendation = 'approve' | 'comment' | 'request_changes';
export type ReviewFindingSeverityV2 = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ReviewFindingCategory = 'security' | 'logic' | 'style' | 'breaking-change';
export type ReviewFindingPassType = 'single' | 'security' | 'logic' | 'style' | 'breaking-change';

export interface ReviewReportSummary {
  riskLevel: ReviewSeverity;
  findingCounts: Record<ReviewFindingSeverityV2, number>;
  recommendation: ReviewRecommendation;
}

export interface ReviewFindingLocation {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewFinding {
  severity: ReviewFindingSeverityV2;
  category: ReviewFindingCategory;
  passType: ReviewFindingPassType;
  locations: ReviewFindingLocation[];
  description: string;
  suggestedFix: string;
}

export interface ReviewFindingLocationV2 {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface ReviewFindingV2 {
  severity: ReviewFindingSeverityV2;
  category: ReviewFindingCategory;
  passType: ReviewFindingPassType;
  locations: ReviewFindingLocationV2[];
  description: string;
  suggestedFix: string;
}

export interface ReviewAnalysisOutputV2 {
  findings: ReviewFindingV2[];
  summary: string;
  furtherPassesLowYield: boolean;
}

export interface ReviewEvidenceItem {
  id: string;
  type: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  metadata?: Record<string, unknown>;
}

export interface ReviewContextDiffHunk {
  path: string;
  patch: string;
}

export interface ReviewContextFile {
  path: string;
  content: string;
  byteSize: number;
  source: 'changed' | 'related' | 'convention';
}

export interface ReviewContextRelatedFile extends ReviewContextFile {
  source: 'related';
  score: number;
  coChangeFrequency: number;
  supportingSessionIds: string[];
}

export interface ReviewContext {
  id: string;
  reviewId: string;
  workspaceId: string;
  deploymentId: string;
  commitSha: string;
  assembledAt: string;
  checkpoint: {
    checkpointId: string;
    branch: 'entire/checkpoints/v1';
    attributionTrailer: string | null;
    session: {
      sessionId: string;
      agentType: string | null;
      sessionIntent: string | null;
    };
  };
  retrieval: {
    changedFiles: ReviewContextFile[];
    diffHunks: ReviewContextDiffHunk[];
    relatedFiles: ReviewContextRelatedFile[];
    conventionFiles: ReviewContextFile[];
    coChange: {
      source: 'entire/checkpoints/v1';
      lookbackSessions: number;
      sessionsScanned: number;
      filesConsidered: number;
      topN: number;
      coChangeSkipped: boolean;
      coChangeSkipReason: string | null;
      coChangeAvailable: boolean;
    };
  };
  stats: {
    totalFilesIncluded: number;
    totalBytesIncluded: number;
    estimatedTokens: number;
    tokenBudget: number | null;
  };
}

export interface ReviewContextRef {
  id: string;
  r2Key: string;
}

export interface ReviewIntentSummary {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}

export interface ReviewProvenanceSummary {
  sessionIds: string[];
  promptSummary: string | null;
  transcriptUrl?: string | null;
  reviewContextRef?: ReviewContextRef | null;
  reviewContextStats?: {
    totalFilesIncluded: number;
    totalBytesIncluded: number;
    estimatedTokens: number;
    tokenBudget: number | null;
  };
  coChange?: {
    coChangeSkipped: boolean;
    coChangeSkipReason: string | null;
    coChangeAvailable: boolean;
    relatedFileCount: number;
  };
  contextResolution?: {
    contextResolution: 'direct' | 'branch_fallback';
    originalCheckpointId: string;
    resolvedCheckpointId: string;
    resolvedCommitSha: string;
    resolvedCommitMessage: string | null;
  };
  outputSchemaVersion?: 'v2';
  passArchitecture?: 'single';
  validation?: {
    firstPassValid: boolean;
    repairAttempted: boolean;
    repairSucceeded: boolean;
    validationErrorCount: number;
    dedupedExactCount: number;
    fallbackApplied?: boolean;
    fallbackReason?: string | null;
  };
  furtherPassesLowYield?: {
    value: boolean;
    source: 'model-self-assessment';
    reliability: 'weak-signal-phase2';
  };
  advisories?: string[];
}

export interface ReviewReport {
  summary: ReviewReportSummary;
  findings: ReviewFinding[];
  summaryText?: string;
  furtherPassesLowYield?: boolean;
  intent: ReviewIntentSummary;
  evidence: ReviewEvidenceItem[];
  provenance: ReviewProvenanceSummary;
  markdownSummary: string | null;
}

export interface ReviewRunRecord {
  id: string;
  workspace_id: string;
  deployment_id: string;
  target_type: ReviewTargetType;
  mode: ReviewMode;
  status: ReviewRunStatus;
  idempotency_key: string;
  request_payload_json: string;
  request_payload_sha256: string;
  provenance_json: string;
  last_event_seq: number;
  attempt_count: number;
  started_at: string | null;
  finished_at: string | null;
  report_json: string | null;
  markdown_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRunResponse {
  id: string;
  workspaceId: string;
  deploymentId: string;
  target: {
    type: ReviewTargetType;
    workspaceId: string;
    deploymentId: string;
  };
  mode: ReviewMode;
  status: ReviewRunStatus;
  idempotencyKey: string;
  attemptCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary?: ReviewReportSummary;
  summaryText?: string;
  furtherPassesLowYield?: boolean;
  findings: ReviewFinding[];
  intent?: ReviewIntentSummary;
  evidence: ReviewEvidenceItem[];
  provenance: ReviewProvenanceSummary;
  markdownSummary: string | null;
  error?: {
    code: string;
    message: string;
  };
}
