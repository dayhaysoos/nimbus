import type { IncomingMessage, ServerResponse } from 'http';

const LOCAL_HOST = '127.0.0.1';
const REVIEW_EVENTS_PATH = /^\/api\/reviews\/([^/]+)\/events$/;
const REVIEW_EVENTS_REPLAY_LIMIT = 200;
const REVIEW_EVENTS_REPLAY_TTL_MS = 60_000;
const REVIEW_EVENTS_REPLAY_HARD_CAP = REVIEW_EVENTS_REPLAY_LIMIT * 2;
const REVIEW_EVENTS_BUFFER_LIMIT_CHARS = 256_000;

export function createProxyHeaders(
  requestHeaders: IncomingMessage['headers'],
  options: {
    apiKey: string | null;
    reviewGithubToken: string | null;
    openrouterApiKey: string | null;
  }
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!value) {
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower === 'content-length') {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  if (options.apiKey) {
    headers.set('X-Nimbus-Api-Key', options.apiKey);
  }
  if (options.reviewGithubToken) {
    headers.set('X-Review-Github-Token', options.reviewGithubToken);
  }
  if (options.openrouterApiKey) {
    headers.set('X-Openrouter-Api-Key', options.openrouterApiKey);
  }

  return headers;
}

interface ReviewEventsChannel {
  replay: string[];
  subscribers: Set<ServerResponse>;
  upstreamAbortController: AbortController | null;
  upstreamTask: Promise<void> | null;
  completed: boolean;
  cleanupTimer: NodeJS.Timeout | null;
}

export interface ReviewEventsFanout {
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  close: () => Promise<void>;
}

export function createReviewEventsFanout(options: {
  workerUrl: string;
  apiKey: string | null;
  reviewGithubToken: string | null;
  openrouterApiKey: string | null;
}): ReviewEventsFanout {
  const channels = new Map<string, ReviewEventsChannel>();

  const isTerminalFrame = (frameBody: string): boolean => {
    const dataLines = frameBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    if (dataLines.length === 0) {
      return false;
    }

    try {
      const payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      const type = typeof payload.type === 'string' ? payload.type : null;
      const status = typeof payload.status === 'string' ? payload.status : null;
      return type === 'terminal' || status === 'succeeded' || status === 'failed' || status === 'cancelled';
    } catch {
      return false;
    }
  };

  const cleanupChannel = (reviewId: string, expectedChannel?: ReviewEventsChannel): void => {
    const channel = channels.get(reviewId);
    if (!channel || (expectedChannel && channel !== expectedChannel)) {
      return;
    }
    if (channel.cleanupTimer) {
      clearTimeout(channel.cleanupTimer);
      channel.cleanupTimer = null;
    }
    if (channel.subscribers.size > 0 || channel.upstreamTask) {
      return;
    }
    channels.delete(reviewId);
  };

  const scheduleCleanup = (reviewId: string): void => {
    const channel = channels.get(reviewId);
    if (!channel || channel.cleanupTimer) {
      return;
    }
    const scheduledChannel = channel;
    channel.cleanupTimer = setTimeout(() => {
      cleanupChannel(reviewId, scheduledChannel);
    }, REVIEW_EVENTS_REPLAY_TTL_MS);
  };

  const ensureChannel = (reviewId: string): ReviewEventsChannel => {
    const existing = channels.get(reviewId);
    if (existing) {
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = null;
      }
      return existing;
    }
    const channel: ReviewEventsChannel = {
      replay: [],
      subscribers: new Set<ServerResponse>(),
      upstreamAbortController: null,
      upstreamTask: null,
      completed: false,
      cleanupTimer: null,
    };
    channels.set(reviewId, channel);
    return channel;
  };

  const pushReplay = (channel: ReviewEventsChannel, frame: string): void => {
    channel.replay.push(frame);
    if (channel.replay.length > REVIEW_EVENTS_REPLAY_LIMIT) {
      channel.replay.splice(0, channel.replay.length - REVIEW_EVENTS_REPLAY_LIMIT);
    }
    if (channel.replay.length > REVIEW_EVENTS_REPLAY_HARD_CAP) {
      channel.replay = channel.replay.slice(-REVIEW_EVENTS_REPLAY_LIMIT);
    }
  };

  const broadcast = (channel: ReviewEventsChannel, frame: string): void => {
    for (const subscriber of channel.subscribers) {
      if (subscriber.destroyed || subscriber.writableEnded) {
        channel.subscribers.delete(subscriber);
        continue;
      }
      try {
        subscriber.write(frame);
      } catch {
        channel.subscribers.delete(subscriber);
      }
    }
  };

  const closeSubscribers = (channel: ReviewEventsChannel): void => {
    for (const subscriber of channel.subscribers) {
      if (!subscriber.writableEnded) {
        subscriber.end();
      }
    }
    channel.subscribers.clear();
  };

  const startUpstream = (reviewId: string, channel: ReviewEventsChannel): void => {
    if (channel.upstreamTask || channel.completed) {
      return;
    }

    const controller = new AbortController();
    let sawTerminalFrame = false;
    channel.upstreamAbortController = controller;
    channel.upstreamTask = (async () => {
      const targetUrl = new URL(`/api/reviews/${encodeURIComponent(reviewId)}/events`, options.workerUrl);
      const upstreamResponse = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: createProxyHeaders(
          {
            accept: 'text/event-stream',
          },
          {
            apiKey: options.apiKey,
            reviewGithubToken: options.reviewGithubToken,
            openrouterApiKey: options.openrouterApiKey,
          }
        ),
        signal: controller.signal,
      });

      if (!upstreamResponse.ok) {
        const errorText = (await upstreamResponse.text()).slice(0, 200);
        const frame = `data: ${JSON.stringify({ type: 'error', reviewId, message: `Worker error (${upstreamResponse.status}): ${errorText}` })}\n\n`;
        pushReplay(channel, frame);
        broadcast(channel, frame);
        return;
      }

      if (!upstreamResponse.body) {
        return;
      }

      const decoder = new TextDecoder();
      const reader = upstreamResponse.body.getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (buffer.length > REVIEW_EVENTS_BUFFER_LIMIT_CHARS) {
          throw new Error(
            `Review events payload exceeded ${REVIEW_EVENTS_BUFFER_LIMIT_CHARS} characters before frame delimiter; stream aborted to avoid truncation`
          );
        }
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frameBody of frames) {
          if (!frameBody.trim()) {
            continue;
          }
          if (!sawTerminalFrame && isTerminalFrame(frameBody)) {
            sawTerminalFrame = true;
          }
          const frame = `${frameBody}\n\n`;
          pushReplay(channel, frame);
          broadcast(channel, frame);
        }
      }

      buffer += decoder.decode().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (buffer.trim()) {
        if (!sawTerminalFrame && isTerminalFrame(buffer)) {
          sawTerminalFrame = true;
        }
        const frame = `${buffer}\n\n`;
        pushReplay(channel, frame);
        broadcast(channel, frame);
      }
    })()
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const frame = `data: ${JSON.stringify({ type: 'error', reviewId, message })}\n\n`;
        pushReplay(channel, frame);
        broadcast(channel, frame);
      })
      .finally(() => {
        channel.completed = sawTerminalFrame;
        channel.upstreamAbortController = null;
        channel.upstreamTask = null;
        closeSubscribers(channel);
        scheduleCleanup(reviewId);
      });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_HOST}`);
    const match = REVIEW_EVENTS_PATH.exec(requestUrl.pathname);
    if (!match) {
      return false;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Method not allowed');
      return true;
    }

    const reviewId = decodeURIComponent(match[1] ?? '').trim();
    if (!reviewId) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Invalid review id');
      return true;
    }

    const channel = ensureChannel(reviewId);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    if (method === 'HEAD') {
      response.end();
      return true;
    }

    for (const frame of channel.replay) {
      response.write(frame);
    }

    if (channel.completed) {
      response.end();
      scheduleCleanup(reviewId);
      return true;
    }

    channel.subscribers.add(response);
    const removeSubscriber = () => {
      channel.subscribers.delete(response);
      if (channel.subscribers.size === 0 && channel.upstreamAbortController) {
        channel.upstreamAbortController.abort();
      }
      scheduleCleanup(reviewId);
    };
    response.on('close', removeSubscriber);
    response.on('error', removeSubscriber);
    request.on('close', removeSubscriber);

    startUpstream(reviewId, channel);
    return true;
  };

  const close = async (): Promise<void> => {
    for (const channel of channels.values()) {
      if (channel.cleanupTimer) {
        clearTimeout(channel.cleanupTimer);
        channel.cleanupTimer = null;
      }
      if (channel.upstreamAbortController) {
        channel.upstreamAbortController.abort();
      }
      closeSubscribers(channel);
    }
    channels.clear();
  };

  return { handle, close };
}
