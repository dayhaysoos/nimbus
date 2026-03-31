import type { ReviewAgentAction } from './tools.js';
import { asRecord, readOptionalString } from './helpers.js';
import {
  isMissingOpenRouterApiKeyError,
  isTimeoutLikeError,
  isWorkerToWorkerFetchRestriction,
  sanitizeErrorMessage,
  sleep,
} from './output.js';

const REVIEW_PROVIDER_TIMEOUT_MS = 120_000;
const REVIEW_PROVIDER_MAX_ATTEMPTS = 2;
const REVIEW_PROVIDER_RETRY_DELAY_MS = 750;

export type ReviewAgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

export interface ReviewAgentProvider {
  next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
  }): Promise<ReviewAgentAction>;
}

export class CloudflareAgentSdkReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly endpoint: string,
    private readonly authToken: string | null,
    private readonly serviceBinding: Fetcher | null,
    private readonly openrouterApiKey: string | null,
    private readonly validateAction: (action: unknown) => ReviewAgentAction
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
  }): Promise<ReviewAgentAction> {
    const requestFetch = this.serviceBinding ? this.serviceBinding.fetch.bind(this.serviceBinding) : fetch;

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        const requestPromise = requestFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            ...(this.openrouterApiKey ? { 'X-Openrouter-Api-Key': this.openrouterApiKey } : {}),
          },
          body: JSON.stringify({
            mode: 'workspace_task',
            prompt: input.prompt,
            model: input.model,
            maxSteps: input.maxSteps,
            step: input.step,
            history: input.history,
          }),
          signal: controller.signal,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_PROVIDER_TIMEOUT_MS);
        });

        const response = await Promise.race([requestPromise, timeoutPromise]);
        if (!response.ok) {
          const providerErrorBody = sanitizeErrorMessage(await response.text(), { openrouterApiKey: this.openrouterApiKey });
          if (isMissingOpenRouterApiKeyError(providerErrorBody)) {
            throw new Error(
              'Review analysis provider is missing an OpenRouter API key. Configure OPENROUTER_API_KEY for nimbus-agent-endpoint or pass X-Openrouter-Api-Key from the caller.'
            );
          }
          if (isWorkerToWorkerFetchRestriction(response.status, providerErrorBody)) {
            throw new Error(
              `Review analysis provider request blocked by Cloudflare Worker-to-Worker fetch restriction (error code 1042). Enable the 'global_fetch_strictly_public' compatibility flag on this worker or switch to a service binding.${providerErrorBody ? ` Provider response: ${providerErrorBody}` : ''}`
            );
          }

          const transientStatus = response.status >= 500 || response.status === 429;
          const statusError = new Error(
            transientStatus
              ? `Review analysis provider temporarily unavailable (status ${response.status})${providerErrorBody ? `: ${providerErrorBody}` : ''}`
              : `Review analysis provider request failed with status ${response.status}${providerErrorBody ? `: ${providerErrorBody}` : ''}`
          );

          if (transientStatus && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
            await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
            continue;
          }

          throw statusError;
        }

        const parsed = (await response.json()) as unknown;
        const action = asRecord(parsed).action;
        return this.validateAction(action);
      } catch (error) {
        const timeoutLike = isTimeoutLikeError(error);
        const transientNetworkError = error instanceof Error && /fetch failed|network|connection reset|econnreset|socket hang up/i.test(error.message);
        if ((timeoutLike || transientNetworkError) && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
          await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (timeoutLike) {
          throw new Error(
            `Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds (attempt ${attempt}/${REVIEW_PROVIDER_MAX_ATTEMPTS})`
          );
        }
        throw error;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}
