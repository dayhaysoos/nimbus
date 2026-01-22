import type { Sandbox } from '@cloudflare/sandbox';

// Environment bindings
export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  OPENROUTER_API_KEY: string;
  DEFAULT_MODEL: string;
  PREVIEW_HOSTNAME: string; // workers.dev hostname for preview URLs (free SSL)
}

// Request/Response types
export interface BuildRequest {
  prompt: string;
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
  | { type: 'generating' }
  | { type: 'generated'; fileCount: number }
  | { type: 'scaffolding' }
  | { type: 'writing' }
  | { type: 'installing' }
  | { type: 'building' }
  | { type: 'starting' }
  | { type: 'complete'; previewUrl: string }
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
