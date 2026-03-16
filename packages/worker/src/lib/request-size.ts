const DEFAULT_MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
const UPLOAD_MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

function isUploadRoute(request: Request): boolean {
  if (request.method !== 'POST') {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  return pathname === '/api/checkpoint/jobs' || pathname === '/api/workspaces';
}

function resolveRequestBodyLimitBytes(request: Request): number {
  return isUploadRoute(request) ? UPLOAD_MAX_REQUEST_BODY_BYTES : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export function enforceRequestBodySizeCap(request: Request, corsHeaders: Record<string, string>): Response | null {
  const maxBytes = resolveRequestBodyLimitBytes(request);
  const raw = request.headers.get('Content-Length');
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const contentLength = Number(trimmed);
  if (!Number.isFinite(contentLength) || contentLength <= maxBytes) {
    return null;
  }

  return new Response(JSON.stringify({ error: 'Request body too large', code: 'request_too_large' }), {
    status: 413,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
