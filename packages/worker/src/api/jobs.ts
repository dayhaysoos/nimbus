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
import { deployToWorkers } from '../lib/deploy/workers.js';
import { isNextWorkersConfig, normalizeNextConfigFiles, parseNimbusConfig } from '../lib/nimbus-config.js';
import type { Env, BuildRequest, SSEEvent, BuildMetrics } from '../types.js';

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
    const startedAt = new Date();

    try {
      // Send job created event
      sendEvent({ type: 'job_created', jobId });

      // Mark job as running
      await markJobRunning(env.DB, jobId);

      // Step 1: Generate code with LLM
      sendEvent({ type: 'generating' });

      const generateResult = await generateCode(env.OPENROUTER_API_KEY, model, body.prompt);
      const nimbusConfig = parseNimbusConfig(generateResult.files);
      const isNextWorkers = isNextWorkersConfig(nimbusConfig);
      const files = isNextWorkers ? normalizeNextConfigFiles(generateResult.files) : generateResult.files;
      const fileCount = files.length;
      console.log('[Nimbus] Job config', jobId, { isNextWorkers, nimbusConfig });

      // Calculate lines of code
      const linesOfCode = files.reduce(
        (sum, file) => sum + file.content.split('\n').length,
        0
      );

      sendEvent({ type: 'generated', fileCount });

      // Step 2: Build in sandbox
      const hostname = env.PREVIEW_HOSTNAME || request.headers.get('host') || new URL(request.url).host;
      const buildResult = await buildInSandbox(env.Sandbox, files, sendEvent, hostname, jobId);
      const previewUrlForJob = buildResult.previewUrl;
      if (!previewUrlForJob) {
        throw new Error('Preview URL missing from build result');
      }
      previewUrl = previewUrlForJob;
      sendEvent({ type: 'preview_ready', previewUrl: previewUrlForJob });

      // Step 3: Deploy to Cloudflare Pages
      sendEvent({ type: 'deploying' });
      let deployedUrl: string;
      let isPreviewFallback = false;
      let deployError: string | undefined;
      const deployStartTime = Date.now();
      try {
        if (isNextWorkers) {
          deployedUrl = await deployToWorkers(env, env.Sandbox, buildResult.sandboxId);
        } else {
          deployedUrl = await deployToPages(env, jobId, env.Sandbox, buildResult.sandboxId);
        }
      } catch (err) {
        const deployMsg = err instanceof Error ? err.message : String(err);
        const deployStack = err instanceof Error ? err.stack : '';
        const deployTarget = isNextWorkers ? 'Workers' : 'Pages';
        console.error(`${deployTarget} deployment failed:`, deployMsg, deployStack);
        sendEvent({ type: 'deploy_warning', message: `${deployTarget} deployment failed: ${deployMsg}` });
        deployedUrl = previewUrlForJob;
        isPreviewFallback = true;
        deployError = deployMsg;
      }
      const deployDurationMs = Date.now() - deployStartTime;

      // Assemble metrics
      const completedAt = new Date();
      const metrics: BuildMetrics = {
        id: jobId,
        prompt: body.prompt,
        model,
        promptTokens: generateResult.usage.promptTokens,
        completionTokens: generateResult.usage.completionTokens,
        totalTokens: generateResult.usage.totalTokens,
        cost: generateResult.usage.cost,
        llmLatencyMs: generateResult.llmLatencyMs,
        filesGenerated: fileCount,
        linesOfCode,
        buildSuccess: true,
        deploySuccess: !isPreviewFallback,
        deployError,
        installDurationMs: buildResult.installDurationMs,
        buildDurationMs: buildResult.buildDurationMs,
        deployDurationMs,
        totalDurationMs: completedAt.getTime() - startedAt.getTime(),
        deployedUrl,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      };

      await markJobCompleted(env.DB, jobId, previewUrlForJob, deployedUrl, metrics);

      sendEvent({ type: 'complete', previewUrl: previewUrlForJob, deployedUrl, isPreviewFallback, metrics });
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
