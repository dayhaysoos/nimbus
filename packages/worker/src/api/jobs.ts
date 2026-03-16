import { getJob, listJobs } from '../lib/db.js';
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

/**
 * Handle GET /api/jobs/:id - Get job status
 */
export async function handleGetJob(jobId: string, env: Env, authContext?: AuthContext): Promise<Response> {
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

    return new Response(JSON.stringify(job), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

/**
 * Handle GET /api/jobs - List all jobs
 */
export async function handleListJobs(env: Env, authContext?: AuthContext): Promise<Response> {
  try {
    const denied = denyHostedNonAdmin(resolveAuthContext(authContext));
    if (denied) {
      return denied;
    }

    const jobs = await listJobs(env.DB);

    return new Response(JSON.stringify({ jobs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
