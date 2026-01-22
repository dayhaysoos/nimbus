import { proxyToSandbox } from '@cloudflare/sandbox';
import { Sandbox } from './sandbox.js';
import { handleCreateJob, handleGetJob, handleListJobs } from './api/jobs.js';
import type { Env } from './types.js';

// Re-export Sandbox for Durable Object binding
export { Sandbox };

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

    // Route: POST /api/jobs - Create new job
    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      return handleCreateJob(request, env);
    }

    // Route: GET /api/jobs - List all jobs
    if (url.pathname === '/api/jobs' && request.method === 'GET') {
      return handleListJobs(env);
    }

    // Route: GET /api/jobs/:id - Get job by ID
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9_]+)$/);
    if (jobMatch && request.method === 'GET') {
      return handleGetJob(jobMatch[1], env);
    }

    // Route: POST /build (legacy, redirect to /api/jobs)
    if (url.pathname === '/build' && request.method === 'POST') {
      return handleCreateJob(request, env);
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
