import { generateCode } from '../openrouter.js';
import { buildInSandbox } from '../sandbox.js';
import {
  generateJobId,
  createJob,
  getJob,
  listJobs,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
} from '../lib/db.js';
import { deployToPages } from '../lib/deploy/pages.js';
import type { Env, BuildRequest, SSEEvent } from '../types.js';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Helper to create SSE formatted message
function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Handle POST /api/jobs - Create a new job and start build
 */
export async function handleCreateJob(request: Request, env: Env): Promise<Response> {
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
      JSON.stringify({
        error: 'OPENROUTER_API_KEY not configured. Run: wrangler secret put OPENROUTER_API_KEY',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  // Use provided model or fall back to default
  const model = body.model || env.DEFAULT_MODEL;

  // Generate job ID and create in database
  const jobId = generateJobId();

  try {
    await createJob(env.DB, jobId, body.prompt, model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: `Failed to create job: ${message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
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
    let previewUrl: string | undefined;
    let fileCount = 0;

    try {
      // Send job created event
      sendEvent({ type: 'job_created', jobId });

      // Mark job as running
      await markJobRunning(env.DB, jobId);

      // Step 1: Generate code with LLM
      sendEvent({ type: 'generating' });

      const generatedCode = await generateCode(env.OPENROUTER_API_KEY, model, body.prompt);
      fileCount = generatedCode.files.length;

      sendEvent({ type: 'generated', fileCount });

      // Step 2: Build in sandbox
      const hostname = env.PREVIEW_HOSTNAME || request.headers.get('host') || new URL(request.url).host;
      const buildResult = await buildInSandbox(env.Sandbox, generatedCode.files, sendEvent, hostname);
      previewUrl = buildResult.previewUrl;

      sendEvent({ type: 'preview_ready', previewUrl });

      // Step 3: Deploy to Cloudflare Pages
      sendEvent({ type: 'deploying' });
      let deployedUrl: string;
      let isPreviewFallback = false;
      try {
        deployedUrl = await deployToPages(env, jobId, env.Sandbox, buildResult.sandboxId);
      } catch (deployError) {
        // If Pages deployment fails, still mark job as completed with preview URL
        const deployMsg = deployError instanceof Error ? deployError.message : String(deployError);
        const deployStack = deployError instanceof Error ? deployError.stack : '';
        console.error('Pages deployment failed:', deployMsg, deployStack);
        sendEvent({ type: 'deploy_warning', message: `Pages deployment failed: ${deployMsg}` });
        deployedUrl = previewUrl;
        isPreviewFallback = true;
      }

      await markJobCompleted(env.DB, jobId, previewUrl, deployedUrl, fileCount);

      sendEvent({ type: 'complete', previewUrl, deployedUrl, isPreviewFallback });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await markJobFailed(env.DB, jobId, message, previewUrl);
      } catch (dbError) {
        // If DB update fails, log but don't overwrite the original error
        console.error('Failed to mark job as failed in DB:', dbError);
      }
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

/**
 * Handle GET /api/jobs/:id - Get job status
 */
export async function handleGetJob(jobId: string, env: Env): Promise<Response> {
  try {
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
export async function handleListJobs(env: Env): Promise<Response> {
  try {
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
