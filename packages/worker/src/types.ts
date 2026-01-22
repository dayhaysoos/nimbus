import type { Sandbox } from '@cloudflare/sandbox';

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  OPENROUTER_API_KEY: string;
  DEFAULT_MODEL: string;
  PREVIEW_HOSTNAME: string;
  PAGES_PROJECT_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

// Request/Response types
export interface BuildRequest {
  prompt: string;
  model?: string;
}

// Job status type
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

// Job record from D1 database
export interface JobRecord {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  preview_url: string | null;
  deployed_url: string | null;
  error_message: string | null;
  file_count: number | null;
}

// Job response for API (camelCase)
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

// Job list item (lightweight for listing)
export interface JobListItem {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  createdAt: string;
  deployedUrl: string | null;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GeneratedCode {
  files: GeneratedFile[];
}

// SSE Event types
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

// OpenRouter types
export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
}

export interface OpenRouterResponse {
  id: string;
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
