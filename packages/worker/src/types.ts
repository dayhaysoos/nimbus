import type { Sandbox } from '@cloudflare/sandbox';

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  DB: D1Database;
  LOGS_BUCKET: R2Bucket;
  OPENROUTER_API_KEY: string;
  DEFAULT_MODEL: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AUTH_TOKEN: string;
}

// Request/Response types
export interface BuildRequest {
  prompt: string;
  model?: string;
}

// Job status type
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'expired';

// Job record from D1 database
export interface JobRecord {
  id: string;
  prompt: string;
  model: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  preview_url: string | null;
  deployed_url: string | null;
  error_message: string | null;
  file_count: number | null;
  build_log_key: string | null;
  deploy_log_key: string | null;
  worker_name: string | null;
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
  expiresAt: string | null;
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
  | { type: 'deploying' }
  | { type: 'deployed'; deployedUrl: string }
  | {
      type: 'complete';
      previewUrl: string;
      deployedUrl: string;
      metrics: BuildMetrics;
    }
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
  response_format?: {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
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
    cost?: number; // May not be returned by all providers
  };
}

// OpenRouter Generation API response (for querying cost after completion)
export interface OpenRouterGenerationResponse {
  data: {
    id: string;
    total_cost: number; // Cost in USD
    native_tokens_prompt: number | null;
    native_tokens_completion: number | null;
    latency: number | null;
  };
}

// Build metrics returned to CLI
// NOTE: This interface is duplicated in packages/cli/src/lib/types.ts - keep them in sync
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
