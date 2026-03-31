import { getReviewRun, listReviewEvents } from '../../lib/db.js';
import type { Env, ReviewRunStatus } from '../../types.js';
import { REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS, recoverStaleRunningReviewIfNeeded } from './recovery.js';
import {
  REVIEW_STREAM_HEARTBEAT_INTERVAL_MS,
  REVIEW_STREAM_POLL_INTERVAL_MS,
  REVIEW_STREAM_STATUS_REFRESH_POLLS,
  REVIEW_TERMINAL_EVENT_GRACE_MS,
  formatSseData,
  formatSseDataWithId,
  isRecord,
  isReviewStatusActive,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  sleep,
} from './shared.js';

function isTerminalEventType(eventType: string): boolean {
  return eventType === 'review_succeeded' || eventType === 'review_failed' || eventType === 'review_cancelled';
}

function statusFromTerminalEventType(eventType: string): ReviewRunStatus | null {
  if (eventType === 'review_succeeded') {
    return 'succeeded';
  }
  if (eventType === 'review_failed') {
    return 'failed';
  }
  if (eventType === 'review_cancelled') {
    return 'cancelled';
  }
  return null;
}

export function createReviewEventsStream(
  env: Env,
  reviewId: string,
  request: Request,
  initialStatus: ReviewRunStatus,
  fromSeq: number
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        let cursor = fromSeq;
        let currentStatus = initialStatus;
        let lastHeartbeatAt = Date.now();
        let sawTerminalEvent = false;
        let terminalGraceDeadline: number | null = null;
        let pollCount = 0;

        const write = (chunk: string): void => {
          controller.enqueue(encoder.encode(chunk));
        };

        const writePersistedEvents = async (): Promise<void> => {
          const persistedEvents = await listReviewEvents(env.DB, reviewId, cursor);
          for (const item of persistedEvents) {
            cursor = item.seq;
            if (isTerminalEventType(item.eventType)) {
              sawTerminalEvent = true;
              currentStatus = statusFromTerminalEventType(item.eventType) ?? currentStatus;
            }
            write(
              formatSseDataWithId(item.seq, {
                type: item.eventType,
                reviewId,
                seq: item.seq,
                createdAt: item.createdAt,
                ...(isRecord(item.payload) ? item.payload : { value: item.payload }),
              })
            );
          }
        };

        await writePersistedEvents();
        write(
          formatSseData({
            type: 'snapshot',
            reviewId,
            status: currentStatus,
          })
        );

        while (isReviewStatusActive(currentStatus)) {
          await sleep(REVIEW_STREAM_POLL_INTERVAL_MS);
          pollCount += 1;
          await writePersistedEvents();

          if (pollCount % REVIEW_STREAM_STATUS_REFRESH_POLLS === 0) {
            const latest = await getReviewRun(env.DB, reviewId);
            if (!latest) {
              write(
                formatSseData({
                  type: 'error',
                  reviewId,
                  message: 'Review not found during event stream',
                })
              );
              break;
            }
            await recoverStaleRunningReviewIfNeeded(
              env,
              reviewId,
              latest,
              readReviewGithubTokenHeader(request),
              readOpenrouterApiKeyHeader(request),
              { markFailedWhenRetryUnavailable: false, noAuthTerminalGraceMs: REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS }
            );
            const refreshed = await getReviewRun(env.DB, reviewId);
            currentStatus = refreshed?.status ?? latest.status;
          }

          if (!isReviewStatusActive(currentStatus) && terminalGraceDeadline === null) {
            terminalGraceDeadline = Date.now() + REVIEW_TERMINAL_EVENT_GRACE_MS;
          }
          if (!isReviewStatusActive(currentStatus) && sawTerminalEvent) {
            break;
          }
          if (terminalGraceDeadline !== null && Date.now() >= terminalGraceDeadline) {
            break;
          }
          if (Date.now() - lastHeartbeatAt >= REVIEW_STREAM_HEARTBEAT_INTERVAL_MS) {
            write(
              formatSseData({
                type: 'heartbeat',
                reviewId,
                status: currentStatus,
              })
            );
            lastHeartbeatAt = Date.now();
          }
        }

        const terminal = await getReviewRun(env.DB, reviewId);
        if (terminal) {
          await writePersistedEvents();
          write(
            formatSseData({
              type: 'terminal',
              reviewId,
              status: terminal.status,
            })
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encoder.encode(
            formatSseData({
              type: 'error',
              reviewId,
              message,
            })
          )
        );
      }
      controller.close();
    },
  });
}
