import type { Env } from '../types.js';
import { loadRuntimeFlags } from '../lib/flags.js';
import {
  appendWorkspaceTaskEvent,
  createWorkspaceTask,
  generateWorkspaceTaskId,
  getWorkspace,
  getWorkspaceTask,
  hasWorkspaceTaskEvent,
  listWorkspaceTaskEvents,
  requestWorkspaceTaskCancel,
  WorkspaceTaskIdempotencyConflictError,
} from '../lib/db.js';
import { createWorkspaceTaskQueueMessage } from '../lib/workspace-task-queue.js';
import { processWorkspaceTask } from '../lib/workspace-task-runner.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function parseInteger(input: unknown, fallback: number, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return fallback;
  }
  const value = Math.floor(input);
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function parseIntegerString(input: string | undefined, fallback: number, min: number, max: number): number {
  if (input === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(input.trim(), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function parseBooleanString(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined) {
    return fallback;
  }
  const normalized = input.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveWorkspaceOrReady(
  env: Env,
  workspaceId: string
): Promise<{ workspace: Awaited<ReturnType<typeof getWorkspace>> | null; response?: Response }> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return { workspace: null, response: jsonResponse({ error: 'Workspace not found' }, 404) };
  }
  if (workspace.status !== 'ready') {
    return {
      workspace,
      response: jsonResponse(
        {
          error: 'Workspace is not ready',
          workspace: {
            id: workspace.id,
            status: workspace.status,
            errorCode: workspace.errorCode,
            errorMessage: workspace.errorMessage,
          },
        },
        409
      ),
    };
  }
  return { workspace };
}

async function ensureWorkspaceExists(env: Env, workspaceId: string): Promise<Response | null> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

async function ensureWorkspaceAgentRuntimeEnabled(env: Env): Promise<Response | null> {
  const flags = await loadRuntimeFlags(env);
  if (!flags.workspaceAgentRuntimeEnabled) {
    return jsonResponse(
      {
        error: 'Workspace agent runtime is disabled',
        code: 'workspace_agent_runtime_disabled',
      },
      403
    );
  }
  return null;
}

async function runTaskInlineWithRetries(
  env: Env,
  workspaceId: string,
  taskId: string,
  maxCycles = 8
): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    try {
      await processWorkspaceTask(env, workspaceId, taskId);
    } catch {
      // Retry scheduling is inferred from persisted task status.
    }

    const latest = await getWorkspaceTask(env.DB, workspaceId, taskId);
    if (!latest) {
      return;
    }
    if (latest.status !== 'queued') {
      return;
    }
    if (latest.error?.code !== 'retry_scheduled') {
      return;
    }
  }
}

function defaultToolPolicy(): Record<string, unknown> {
  return {
    commands: {
      allow: ['git status', 'git diff', 'git add', 'git restore', 'ls', 'pwd'],
      deny: ['rm -rf /', 'sudo', 'curl', 'wget', 'ssh', 'dd', 'mkfs'],
    },
    filePaths: {
      root: '/workspace',
      deny: ['.git/**'],
    },
    limits: {
      maxCommandTimeoutMs: 900000,
      maxSteps: 60,
      maxOutputBytes: 32000,
    },
    autonomy: 'full',
  };
}

export async function handleCreateWorkspaceTask(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  try {
    const enabledResponse = await ensureWorkspaceAgentRuntimeEnabled(env);
    if (enabledResponse) {
      return enabledResponse;
    }

    const workspaceCheck = await resolveWorkspaceOrReady(env, workspaceId);
    if (workspaceCheck.response) {
      return workspaceCheck.response;
    }

    if (!env.WORKSPACE_TASKS_QUEUE && !ctx) {
      return jsonResponse(
        {
          error: 'Workspace task runner is unavailable',
          code: 'workspace_task_runner_unavailable',
        },
        503
      );
    }

    const idempotencyKey = (request.headers.get('Idempotency-Key') ?? '').trim();
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }

    const payloadRaw = await request.text();
    let payload: Record<string, unknown> = {};
    if (payloadRaw.trim()) {
      const parsed = JSON.parse(payloadRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
      }
      payload = parsed as Record<string, unknown>;
    }

    const prompt = String(payload.prompt ?? '').trim();
    if (!prompt) {
      return jsonResponse({ error: 'Task prompt is required' }, 400);
    }

    const providerInput = payload.provider ?? env.AGENT_PROVIDER ?? 'cloudflare_agents_sdk';
    const modelInput = payload.model ?? env.AGENT_MODEL ?? 'claude-3-7-sonnet';
    if (typeof providerInput !== 'string' || !providerInput.trim()) {
      return jsonResponse({ error: 'provider must be a non-empty string' }, 400);
    }
    if (typeof modelInput !== 'string' || !modelInput.trim()) {
      return jsonResponse({ error: 'model must be a non-empty string' }, 400);
    }
    const provider = providerInput.trim();
    const model = modelInput.trim();
    const allowScriptedProvider = parseBooleanString(env.WORKSPACE_AGENT_ALLOW_SCRIPTED_PROVIDER, false);
    if (provider === 'scripted' && !allowScriptedProvider) {
      return jsonResponse(
        {
          error: 'scripted provider is disabled',
          code: 'scripted_provider_disabled',
        },
        403
      );
    }
    if (payload.scriptedActions !== undefined && provider !== 'scripted') {
      return jsonResponse({ error: 'scriptedActions is only allowed with provider=scripted' }, 400);
    }
    const maxStepsDefault = parseIntegerString(env.WORKSPACE_AGENT_MAX_STEPS, 24, 1, 120);
    const maxRetriesDefault = parseIntegerString(env.WORKSPACE_AGENT_MAX_RETRIES, 2, 0, 5);
    const maxSteps = parseInteger(payload.maxSteps, maxStepsDefault, 1, 120);
    const maxRetries = parseInteger(payload.maxRetries, maxRetriesDefault, 0, 5);

    const requestPayload = {
      prompt,
      provider,
      model,
      maxSteps,
      maxRetries,
      scriptedActions: payload.scriptedActions ?? null,
    };

    const requestPayloadSha256 = await sha256Hex(JSON.stringify(requestPayload));
    const created = await createWorkspaceTask(env.DB, {
      id: generateWorkspaceTaskId(),
      workspaceId,
      prompt,
      provider,
      model,
      idempotencyKey,
      requestPayload,
      requestPayloadSha256,
      maxSteps,
      maxRetries,
      toolPolicy: defaultToolPolicy(),
    });

    const task = created.task;
    if (!created.reused) {
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId: task.id,
        eventType: 'task_created',
        payload: {
          provider: task.provider,
          model: task.model,
          maxSteps: task.maxSteps,
          maxRetries: task.maxRetries,
        },
      });
    }

    if (task.status === 'queued') {
      const alreadyEnqueued = await hasWorkspaceTaskEvent(env.DB, workspaceId, task.id, 'task_enqueued');
      const shouldReenqueueRecoveredTask =
        created.reused && (task.error?.code === 'retry_scheduled' || task.attemptCount > 0);
      if (!alreadyEnqueued || shouldReenqueueRecoveredTask) {
        let scheduled = false;
        if (env.WORKSPACE_TASKS_QUEUE) {
          await env.WORKSPACE_TASKS_QUEUE.send(createWorkspaceTaskQueueMessage(workspaceId, task.id));
          scheduled = true;
        } else if (ctx) {
          const maxCycles = Math.max(1, task.maxRetries + 1);
          ctx.waitUntil(runTaskInlineWithRetries(env, workspaceId, task.id, maxCycles));
          scheduled = true;
        }

        if (scheduled) {
          await appendWorkspaceTaskEvent(env.DB, {
            workspaceId,
            taskId: task.id,
            eventType: 'task_enqueued',
            payload: {
              mode: env.WORKSPACE_TASKS_QUEUE ? 'queue' : 'inline',
              reused: created.reused,
            },
          });
        }
      }
    }

    return jsonResponse({ task }, created.reused ? 200 : 202);
  } catch (error) {
    if (error instanceof WorkspaceTaskIdempotencyConflictError) {
      return jsonResponse(
        {
          error: 'Idempotency key has already been used with different payload',
          code: 'idempotency_key_conflict',
        },
        409
      );
    }

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create workspace task: ${message}` }, 500);
  }
}

export async function handleGetWorkspaceTask(
  workspaceId: string,
  taskId: string,
  env: Env
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const task = await getWorkspaceTask(env.DB, workspaceId, taskId);
  if (!task) {
    return jsonResponse({ error: 'Task not found' }, 404);
  }

  return jsonResponse({ task });
}

export async function handleGetWorkspaceTaskEvents(
  workspaceId: string,
  taskId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const task = await getWorkspaceTask(env.DB, workspaceId, taskId);
  if (!task) {
    return jsonResponse({ error: 'Task not found' }, 404);
  }

  const url = new URL(request.url);
  const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '500', 10);
  const fromExclusive = Number.isFinite(from) && from > 0 ? from : 0;
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 500;

  const events = await listWorkspaceTaskEvents(env.DB, workspaceId, taskId, fromExclusive, boundedLimit);
  return jsonResponse({ taskId, events });
}

export async function handleCancelWorkspaceTask(
  workspaceId: string,
  taskId: string,
  env: Env
): Promise<Response> {
  const workspaceMissing = await ensureWorkspaceExists(env, workspaceId);
  if (workspaceMissing) {
    return workspaceMissing;
  }

  const cancelResult = await requestWorkspaceTaskCancel(env.DB, workspaceId, taskId);
  if (!cancelResult.task) {
    return jsonResponse({ error: 'Task not found' }, 404);
  }

  if (cancelResult.updated) {
    if (cancelResult.task.status === 'cancelled') {
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_cancelled',
        payload: {
          reason: 'cancel_requested',
          cancelRequestedAt: cancelResult.task.cancelRequestedAt,
        },
      });
    } else {
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_cancel_requested',
        payload: {
          status: cancelResult.task.status,
          cancelRequestedAt: cancelResult.task.cancelRequestedAt,
        },
      });
    }
    return jsonResponse({ task: cancelResult.task }, 202);
  }

  if (cancelResult.task.status === 'running' && cancelResult.task.cancelRequestedAt) {
    return jsonResponse({ task: cancelResult.task }, 202);
  }

  return jsonResponse(
    {
      error: 'Task is already terminal and cannot be cancelled',
      code: 'task_not_cancellable',
      task: cancelResult.task,
    },
    409
  );
}
