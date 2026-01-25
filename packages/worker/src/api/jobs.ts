import { getSandbox } from '@cloudflare/sandbox';
import { generateCode } from '../openrouter.js';
import { buildInSandbox } from '../sandbox.js';
import {
  generateJobId,
  createJob,
  getJob,
  listJobs,
  getJobLogKeys,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
} from '../lib/db.js';
import { deployToWorkers, DeployError } from '../lib/deploy/workers.js';
import { isNextWorkersConfig, normalizeNextConfigFiles, parseNimbusConfig } from '../lib/nimbus-config.js';
import { buildWorkerName } from '../lib/worker-name.js';
import { SandboxBuildError } from '../sandbox.js';
import type { Env, BuildRequest, SSEEvent, BuildMetrics } from '../types.js';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Auth',
};

const LOG_DIR = '/root/app/.nimbus';
const BUILD_LOG_PATH = `${LOG_DIR}/build.log`;
const DEPLOY_LOG_PATH = `${LOG_DIR}/deploy.log`;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

function createLogKey(jobId: string, type: 'build' | 'deploy'): string {
  return `jobs/${jobId}/${type}.log`;
}

async function readSandboxLog(
  env: Env,
  sandboxId: string,
  filePath: string
): Promise<string | null> {
  try {
    const sandbox = getSandbox(env.Sandbox, sandboxId);
    const result = await sandbox.exec(
      `if [ -f "${filePath}" ]; then cat "${filePath}"; fi`
    );
    const content = result.stdout?.trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

async function uploadLog(
  env: Env,
  key: string,
  contents: string | null
): Promise<string | null> {
  if (!contents) {
    return null;
  }
  try {
    await env.LOGS_BUCKET.put(key, contents, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
    return key;
  } catch (error) {
    console.error('[Logs] Failed to upload log:', error);
    return null;
  }
}

async function destroySandbox(env: Env, sandboxId: string | null): Promise<void> {
  if (!sandboxId) {
    return;
  }
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  try {
    await sandbox.destroy();
  } catch {
    // Ignore cleanup errors
  }
}

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: 'AUTH_TOKEN not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  const authHeader = request.headers.get('Auth');
  if (authHeader !== env.AUTH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  return null;
}

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
    let sandboxId: string | null = null;
    let buildLogKey: string | null = null;
    let deployLogKey: string | null = null;
    let workerName: string | null = null;
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
      const buildResult = await buildInSandbox(env.Sandbox, files, sendEvent, jobId);
      sandboxId = buildResult.sandboxId;
      workerName = buildWorkerName(jobId);

      // Step 3: Deploy to Cloudflare Workers
      sendEvent({ type: 'deploying' });
      const deployStartTime = Date.now();
      const deployResult = await deployToWorkers(env, env.Sandbox, buildResult.sandboxId);
      const deployedUrl = deployResult.deployedUrl;
      const deployDurationMs = Date.now() - deployStartTime;
      const expiresAt = new Date(Date.now() + LOG_RETENTION_MS).toISOString();

      const buildLogContents = await readSandboxLog(env, buildResult.sandboxId, BUILD_LOG_PATH);
      const deployLogContents = deployResult.deployLog ??
        (await readSandboxLog(env, buildResult.sandboxId, DEPLOY_LOG_PATH));

      buildLogKey = await uploadLog(env, createLogKey(jobId, 'build'), buildLogContents);
      deployLogKey = await uploadLog(env, createLogKey(jobId, 'deploy'), deployLogContents);

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
        deploySuccess: true,
        installDurationMs: buildResult.installDurationMs,
        buildDurationMs: buildResult.buildDurationMs,
        deployDurationMs,
        totalDurationMs: completedAt.getTime() - startedAt.getTime(),
        deployedUrl,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      };

      await markJobCompleted(env.DB, jobId, deployedUrl, deployedUrl, metrics, {
        expiresAt,
        workerName: workerName ?? undefined,
        buildLogKey: buildLogKey ?? undefined,
        deployLogKey: deployLogKey ?? undefined,
      });

      sendEvent({ type: 'deployed', deployedUrl });
      sendEvent({ type: 'complete', previewUrl: deployedUrl, deployedUrl, metrics });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let sandboxToRead = sandboxId;
      if (error instanceof SandboxBuildError) {
        sandboxToRead = error.sandboxId;
        sandboxId = error.sandboxId;
      }
      const expiresAt = new Date(Date.now() + LOG_RETENTION_MS).toISOString();
      if (sandboxToRead) {
        const buildLogContents = await readSandboxLog(env, sandboxToRead, BUILD_LOG_PATH);
        const deployLogContents = error instanceof DeployError
          ? error.deployLog
          : await readSandboxLog(env, sandboxToRead, DEPLOY_LOG_PATH);
        buildLogKey = await uploadLog(env, createLogKey(jobId, 'build'), buildLogContents);
        deployLogKey = await uploadLog(env, createLogKey(jobId, 'deploy'), deployLogContents);
      }
      try {
        await markJobFailed(env.DB, jobId, message, undefined, {
          buildLogKey: buildLogKey ?? undefined,
          deployLogKey: deployLogKey ?? undefined,
          workerName: workerName ?? undefined,
          expiresAt,
        });
      } catch (dbError) {
        // If DB update fails, log but don't overwrite the original error
        console.error('Failed to mark job as failed in DB:', dbError);
      }
      sendEvent({ type: 'error', message });
    } finally {
      await destroySandbox(env, sandboxId);
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

/**
 * Handle GET /api/jobs/:id/logs?type=build|deploy
 */
export async function handleGetJobLogs(
  request: Request,
  env: Env,
  jobId: string
): Promise<Response> {
  const authError = requireAuth(request, env);
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  if (type !== 'build' && type !== 'deploy') {
    return new Response(JSON.stringify({ error: 'Invalid log type' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    const logKeys = await getJobLogKeys(env.DB, jobId);
    if (!logKeys) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const logKey = type === 'build' ? logKeys.buildLogKey : logKeys.deployLogKey;
    if (!logKey) {
      return new Response(JSON.stringify({ error: 'Log not available' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const object = await env.LOGS_BUCKET.get(logKey);
    if (!object) {
      return new Response(JSON.stringify({ error: 'Log not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(await object.text(), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
