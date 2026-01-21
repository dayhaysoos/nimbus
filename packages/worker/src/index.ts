import { proxyToSandbox } from '@cloudflare/sandbox';
import { generateCode } from './openrouter.js';
import { buildInSandbox, Sandbox } from './sandbox.js';
import type { Env, BuildRequest, SSEEvent } from './types.js';

// Re-export Sandbox for Durable Object binding
export { Sandbox };

// Helper to create SSE formatted message
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// CORS headers for local development
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Proxy preview URL requests to sandbox
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    // Route: POST /build
    if (url.pathname === '/build' && request.method === 'POST') {
      return handleBuild(request, env);
    }

    // Route: GET /health
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 404 for unknown routes
    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};

async function handleBuild(request: Request, env: Env): Promise<Response> {
  // Parse request body
  let body: BuildRequest;
  try {
    body = (await request.json()) as BuildRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (!body.prompt || typeof body.prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing or invalid prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // Validate API key is configured
  if (!env.OPENROUTER_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'OPENROUTER_API_KEY not configured. Run: wrangler secret put OPENROUTER_API_KEY' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  // Create SSE stream
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Helper to send SSE events
  const sendEvent = (event: SSEEvent) => {
    writer.write(encoder.encode(formatSSE(event)));
  };

  // Run the build process asynchronously
  (async () => {
    try {
      // Step 1: Generate code with LLM
      sendEvent({ type: 'generating' });

      const generatedCode = await generateCode(
        env.OPENROUTER_API_KEY,
        env.DEFAULT_MODEL,
        body.prompt
      );

      sendEvent({ type: 'generated', fileCount: generatedCode.files.length });

      // Step 2: Build in sandbox
      // Get hostname from request for preview URL generation
      const hostname = request.headers.get('host') || new URL(request.url).host;
      const previewUrl = await buildInSandbox(env.Sandbox, generatedCode.files, sendEvent, hostname);

      // Step 3: Complete
      sendEvent({ type: 'complete', previewUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendEvent({ type: 'error', message });
    } finally {
      writer.close();
    }
  })();

  // Return SSE response immediately
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders,
    },
  });
}
