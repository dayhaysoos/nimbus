import { getReviewRun } from './lib/db.js';
import { runReviewInlineWithRetries } from './lib/review-runner.js';
import type { Env } from './types.js';

interface ReviewRunnerStartRequest {
  reviewId: string;
  cochangeGithubToken?: string;
  providerApiKey?: string;
  openrouterApiKey?: string;
}

interface ReviewRunnerState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  reviewId: string | null;
  startedAt: string | null;
  updatedAt: string;
  runCount: number;
  lastError: string | null;
  executionToken: string | null;
}

const STATE_KEY = 'state';

let reviewRunnerExecutorForTests: null | ((
  env: Env,
  reviewId: string,
  maxCycles?: number,
  options?: { cochangeGithubToken?: string | null; providerApiKey?: string | null; openrouterApiKey?: string | null }
) => Promise<void>) = null;

function defaultState(): ReviewRunnerState {
  const now = new Date().toISOString();
  return {
    status: 'idle',
    reviewId: null,
    startedAt: null,
    updatedAt: now,
    runCount: 0,
    lastError: null,
    executionToken: null,
  };
}

function generateExecutionToken(): string {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `review-runner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseRunRequest(payload: unknown): ReviewRunnerStartRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid_payload');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.reviewId !== 'string' || !record.reviewId.trim()) {
    throw new Error('invalid_review_id');
  }
  if (
    record.cochangeGithubToken !== undefined &&
    (typeof record.cochangeGithubToken !== 'string' || !record.cochangeGithubToken.trim())
  ) {
    throw new Error('invalid_cochange_github_token');
  }
  if (
    record.providerApiKey !== undefined &&
    (typeof record.providerApiKey !== 'string' || !record.providerApiKey.trim())
  ) {
    throw new Error('invalid_provider_api_key');
  }
  if (
    record.openrouterApiKey !== undefined &&
    (typeof record.openrouterApiKey !== 'string' || !record.openrouterApiKey.trim())
  ) {
    throw new Error('invalid_openrouter_api_key');
  }
  return {
    reviewId: record.reviewId.trim(),
    cochangeGithubToken:
      typeof record.cochangeGithubToken === 'string' && record.cochangeGithubToken.trim()
        ? record.cochangeGithubToken.trim()
        : undefined,
    providerApiKey:
      typeof record.providerApiKey === 'string' && record.providerApiKey.trim()
        ? record.providerApiKey.trim()
        : undefined,
    openrouterApiKey:
      typeof record.openrouterApiKey === 'string' && record.openrouterApiKey.trim()
        ? record.openrouterApiKey.trim()
        : undefined,
  };
}

export class ReviewRunner {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  private async loadState(): Promise<ReviewRunnerState> {
    return (await this.state.storage.get<ReviewRunnerState>(STATE_KEY)) ?? defaultState();
  }

  private async persistState(next: ReviewRunnerState): Promise<void> {
    await this.state.storage.put(STATE_KEY, next);
  }

  private async lookupAuthoritativeReviewStatus(reviewId: string): Promise<string | null> {
    try {
      return (await getReviewRun(this.env.DB, reviewId))?.status ?? null;
    } catch {
      // D1 claim fencing remains authoritative even if this best-effort lookup fails.
      return null;
    }
  }

  private async persistTerminalStateIfCurrent(
    executionToken: string,
    status: 'completed' | 'failed',
    lastError: string | null
  ): Promise<void> {
    const current = await this.loadState();
    if (current.executionToken !== executionToken) {
      return;
    }
    await this.persistState({
      ...current,
      status,
      updatedAt: new Date().toISOString(),
      lastError,
      executionToken: null,
    });
  }

  private async execute(
    reviewId: string,
    executionToken: string,
    cochangeGithubToken?: string,
    providerApiKey?: string,
    openrouterApiKey?: string
  ): Promise<void> {
    const executor = reviewRunnerExecutorForTests ?? runReviewInlineWithRetries;
    try {
      await executor(this.env, reviewId, 4, {
        cochangeGithubToken,
        providerApiKey,
        openrouterApiKey,
      });
      await this.persistTerminalStateIfCurrent(executionToken, 'completed', null);
    } catch (error) {
      await this.persistTerminalStateIfCurrent(
        executionToken,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/run') {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let payload: ReviewRunnerStartRequest;
    try {
      payload = parseRunRequest((await request.json()) as unknown);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'invalid_payload',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const current = await this.loadState();
    if (current.status === 'running' && current.reviewId === payload.reviewId) {
      const authoritativeStatus = await this.lookupAuthoritativeReviewStatus(payload.reviewId);
      if (authoritativeStatus === 'running') {
        return new Response(JSON.stringify({ accepted: true, status: 'already_running' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const executionToken = generateExecutionToken();
    const now = new Date().toISOString();
    await this.persistState({
      status: 'running',
      reviewId: payload.reviewId,
      startedAt: now,
      updatedAt: now,
      runCount: current.runCount + 1,
      lastError: null,
      executionToken,
    });

    this.state.waitUntil(
      this.execute(
        payload.reviewId,
        executionToken,
        payload.cochangeGithubToken,
        payload.providerApiKey,
        payload.openrouterApiKey
      )
    );

    return new Response(JSON.stringify({ accepted: true, status: 'started' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export function setReviewRunnerExecutorForTests(
  executor: null | ((
    env: Env,
    reviewId: string,
    maxCycles?: number,
    options?: { cochangeGithubToken?: string | null; providerApiKey?: string | null; openrouterApiKey?: string | null }
  ) => Promise<void>)
): void {
  reviewRunnerExecutorForTests = executor;
}
