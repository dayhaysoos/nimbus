export function enforceRequestBodySizeCap(
  request: Request,
  maxBytes: number,
  corsHeaders: Record<string, string>
): Response | null {
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
