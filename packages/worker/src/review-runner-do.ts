import { runReviewInlineWithRetries } from './lib/review-runner.js';
import type { Env } from './types.js';

interface ReviewRunnerStartRequest {
  reviewId: string;
  cochangeGithubToken?: string;
}

interface ReviewRunnerState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  reviewId: string | null;
  startedAt: string | null;
  updatedAt: string;
  runCount: number;
  lastError: string | null;
}

const STATE_KEY = 'state';

let reviewRunnerExecutorForTests: null | ((
  env: Env,
  reviewId: string,
  maxCycles?: number,
  options?: { cochangeGithubToken?: string | null }
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
  };
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
  return {
    reviewId: record.reviewId.trim(),
    cochangeGithubToken:
      typeof record.cochangeGithubToken === 'string' && record.cochangeGithubToken.trim()
        ? record.cochangeGithubToken.trim()
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

  private async execute(reviewId: string, cochangeGithubToken?: string): Promise<void> {
    const executor = reviewRunnerExecutorForTests ?? runReviewInlineWithRetries;
    try {
      await executor(this.env, reviewId, 4, {
        cochangeGithubToken,
      });
      const current = await this.loadState();
      await this.persistState({
        ...current,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        lastError: null,
      });
    } catch (error) {
      const current = await this.loadState();
      await this.persistState({
        ...current,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
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
      return new Response(JSON.stringify({ accepted: true, status: 'already_running' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await this.persistState({
      status: 'running',
      reviewId: payload.reviewId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runCount: current.runCount + 1,
      lastError: null,
    });

    this.state.waitUntil(this.execute(payload.reviewId, payload.cochangeGithubToken));

    return new Response(JSON.stringify({ accepted: true, status: 'started' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export function setReviewRunnerExecutorForTests(
  executor: null | ((env: Env, reviewId: string, maxCycles?: number, options?: { cochangeGithubToken?: string | null }) => Promise<void>)
): void {
  reviewRunnerExecutorForTests = executor;
}
