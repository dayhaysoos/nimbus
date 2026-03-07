import type { Sandbox } from '@cloudflare/sandbox';

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  SOURCE_BUNDLES?: R2Bucket;
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
}
