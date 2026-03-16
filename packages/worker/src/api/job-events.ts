import { getJob, listJobEvents } from '../lib/db.js';
import type { AuthContext, Env } from '../types.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Nimbus-Api-Key',
};

function denyHostedNonAdmin(authContext: AuthContext): Response | null {
  if (authContext.isHostedMode && !authContext.isAdmin) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  return null;
}

function resolveAuthContext(authContext?: AuthContext): AuthContext {
  return (
    authContext ?? {
      accountId: 'self-hosted',
      isAdmin: false,
      isAuthenticated: false,
      isHostedMode: false,
    }
  );
}

function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function formatSseDataWithId(seq: number, payload: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeReplayEventPayload(payload: unknown): Record<string, unknown> {
  if (isRecord(payload)) {
    return payload;
  }

  return { value: payload };
}

function resolveFromSequence(request: Request): number {
  const url = new URL(request.url);
  const fromParam = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const lastEventId = Number.parseInt(request.headers.get('Last-Event-ID') ?? '', 10);

  if (Number.isFinite(lastEventId) && lastEventId >= 0) {
    return lastEventId;
  }

  if (Number.isFinite(fromParam) && fromParam >= 0) {
    return fromParam;
  }

  return 0;
}

/**
 * Handle GET /api/jobs/:id/events - lightweight snapshot stream
 */
export async function handleGetJobEvents(
  jobId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const denied = denyHostedNonAdmin(resolveAuthContext(authContext));
    if (denied) {
      return denied;
    }

    const job = await getJob(env.DB, jobId);

    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const fromSeq = resolveFromSequence(request);
    const persistedEvents = await listJobEvents(env.DB, jobId, fromSeq);

    const replayBody = persistedEvents
      .map((item) =>
        formatSseDataWithId(item.seq, {
          type: item.eventType,
          jobId,
          phase: item.phase,
          seq: item.seq,
          createdAt: item.createdAt,
          ...normalizeReplayEventPayload(item.payload),
        })
      )
      .join('');

    const snapshotBody = formatSseData({
      type: 'snapshot',
      jobId,
      status: job.status,
      phase: job.phase,
    });

    const body = replayBody ? `${replayBody}${snapshotBody}` : snapshotBody;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
