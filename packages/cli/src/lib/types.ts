// Build metrics returned from worker
// NOTE: This interface is duplicated in packages/worker/src/types.ts - keep them in sync
export interface BuildMetrics {
  id: string;
  prompt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  llmLatencyMs: number;
  filesGenerated: number;
  linesOfCode: number;
  buildSuccess: boolean;
  deploySuccess: boolean;
  deployError?: string;
  installDurationMs: number;
  buildDurationMs: number;
  deployDurationMs: number;
  totalDurationMs: number;
  deployedUrl: string;
  startedAt: string;
  completedAt: string;
}

// SSE Event types (matching worker)
export type LogPhase = 'install' | 'build';
export type SSEEvent =
  | { type: 'job_created'; jobId: string }
  | { type: 'generating' }
  | { type: 'generated'; fileCount: number }
  | { type: 'scaffolding' }
  | { type: 'writing' }
  | { type: 'installing' }
  | { type: 'building' }
  | { type: 'log'; phase: LogPhase; message: string }
  | { type: 'starting' }
  | { type: 'preview_ready'; previewUrl: string }
  | { type: 'deploying' }
  | { type: 'deploy_warning'; message: string }
  | { type: 'deployed'; deployedUrl: string }
  | {
      type: 'complete';
      previewUrl: string;
      deployedUrl: string;
      isPreviewFallback?: boolean;
      metrics: BuildMetrics;
    }
  | { type: 'error'; message: string };

// Job status type
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

// Job response from API
export interface JobResponse {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  previewUrl: string | null;
  deployedUrl: string | null;
  errorMessage: string | null;
  fileCount: number | null;
}

// Job list item (lightweight)
export interface JobListItem {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  createdAt: string;
  deployedUrl: string | null;
}

// Jobs list response
export interface JobsListResponse {
  jobs: JobListItem[];
}
