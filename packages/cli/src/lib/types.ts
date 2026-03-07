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
