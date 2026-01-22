// SSE Event types (matching worker)
export type SSEEvent =
  | { type: 'job_created'; jobId: string }
  | { type: 'generating' }
  | { type: 'generated'; fileCount: number }
  | { type: 'scaffolding' }
  | { type: 'writing' }
  | { type: 'installing' }
  | { type: 'building' }
  | { type: 'starting' }
  | { type: 'preview_ready'; previewUrl: string }
  | { type: 'deploying' }
  | { type: 'deploy_warning'; message: string }
  | { type: 'deployed'; deployedUrl: string }
  | { type: 'complete'; previewUrl: string; deployedUrl: string; isPreviewFallback?: boolean }
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
