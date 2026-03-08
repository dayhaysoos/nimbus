import type { Sandbox } from '@cloudflare/sandbox';
import type { Env, WorkspaceTaskResponse } from '../types.js';
import {
  appendWorkspaceTaskEvent,
  claimWorkspaceTaskForExecution,
  getWorkspace,
  getWorkspaceTask,
  getWorkspaceTaskRequestPayload,
  getWorkspaceTaskToolPolicy,
  updateWorkspaceTaskStatus,
} from './db.js';
import { loadRuntimeFlags } from './flags.js';

const WORKSPACE_ROOT = '/workspace';
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, contents: string): Promise<unknown>;
}

type AgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
  | { type: 'tool'; tool: 'write_file'; args: { path: string; content: string } }
  | { type: 'tool'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'tool'; tool: 'diff_summary'; args: { maxBytes?: number } }
  | { type: 'final'; summary: string };

type AgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

interface AgentProvider {
  next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: AgentHistoryEntry[];
  }): Promise<AgentAction>;
}

interface TaskToolPolicy {
  commandAllow: string[];
  commandDeny: string[];
  maxCommandTimeoutMs: number;
  maxOutputBytes: number;
  rootPath: string;
  denyPaths: string[];
}

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

class PolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function assertWorkspacePath(pathInput: string, policy: TaskToolPolicy): string {
  const trimmed = (pathInput || '.').trim();
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.includes('\u0000')) {
    throw new PolicyError('invalid_path', 'Path contains null bytes');
  }
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new PolicyError('invalid_path', 'Path escapes workspace root');
  }

  const collapsed = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  if (collapsed.startsWith('..')) {
    throw new PolicyError('invalid_path', 'Path escapes workspace root');
  }
  if (collapsed === '.git' || collapsed.startsWith('.git/')) {
    throw new PolicyError('invalid_path', 'Access to .git is denied by policy');
  }

  for (const deny of policy.denyPaths) {
    const normalizedDeny = deny.trim().replace(/^\//, '');
    if (!normalizedDeny) {
      continue;
    }
    if (normalizedDeny.endsWith('/**')) {
      const prefix = normalizedDeny.slice(0, -3);
      if (collapsed === prefix || collapsed.startsWith(`${prefix}/`)) {
        throw new PolicyError('invalid_path', `Access to '${prefix}' is denied by policy`);
      }
      continue;
    }

    if (collapsed === normalizedDeny || collapsed.startsWith(`${normalizedDeny}/`)) {
      throw new PolicyError('invalid_path', `Access to '${normalizedDeny}' is denied by policy`);
    }
  }

  return `${policy.rootPath}/${collapsed}`;
}

function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/ghs_[a-z0-9_]+/gi, '[REDACTED_TOKEN]');
}

function isTransientFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(timeout|timed out|temporar|network|fetch failed|connection reset|sandbox unavailable)/i.test(message);
}

function parseNumber(value: unknown, fallback: number, min: number, max: number): number {
  const source = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const n = Math.floor(source);
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}

function parseIntegerString(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
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

function parseBooleanString(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeToolPolicy(input: Record<string, unknown> | null): TaskToolPolicy {
  const commands = (input?.commands ?? {}) as Record<string, unknown>;
  const allowRaw = Array.isArray(commands.allow) ? commands.allow : [];
  const denyRaw = Array.isArray(commands.deny) ? commands.deny : [];
  const limits = (input?.limits ?? {}) as Record<string, unknown>;
  const filePaths = (input?.filePaths ?? {}) as Record<string, unknown>;

  const commandAllow = allowRaw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const commandDeny = denyRaw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const maxCommandTimeoutMs = parseNumber(limits.maxCommandTimeoutMs, MAX_COMMAND_TIMEOUT_MS, 1_000, MAX_COMMAND_TIMEOUT_MS);
  const maxOutputBytes = parseNumber(limits.maxOutputBytes, 32_000, 1_024, 512_000);
  const rootPathRaw = typeof filePaths.root === 'string' ? filePaths.root.trim() : WORKSPACE_ROOT;
  const rootPath = rootPathRaw.startsWith('/') ? rootPathRaw : WORKSPACE_ROOT;
  const denyPaths = Array.isArray(filePaths.deny)
    ? filePaths.deny.filter((value): value is string => typeof value === 'string')
    : ['.git/**'];

  return {
    commandAllow,
    commandDeny,
    maxCommandTimeoutMs,
    maxOutputBytes,
    rootPath,
    denyPaths,
  };
}

class ScriptedAgentProvider implements AgentProvider {
  private readonly actions: AgentAction[];

  constructor(actions: AgentAction[]) {
    this.actions = actions;
  }

  async next(input: { step: number }): Promise<AgentAction> {
    if (input.step - 1 >= this.actions.length) {
      return { type: 'final', summary: 'Scripted task completed' };
    }

    return this.actions[input.step - 1];
  }
}

class CloudflareAgentSdkProvider implements AgentProvider {
  constructor(
    private readonly endpoint: string,
    private readonly authToken: string | null
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: AgentHistoryEntry[];
  }): Promise<AgentAction> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
      },
      body: JSON.stringify({
        mode: 'workspace_task',
        prompt: input.prompt,
        model: input.model,
        maxSteps: input.maxSteps,
        step: input.step,
        history: input.history,
      }),
    });

    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        throw new QueueRetryError(`Cloudflare Agent SDK request failed with status ${response.status}`);
      }
      throw new Error(`Cloudflare Agent SDK request failed with status ${response.status}`);
    }

    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cloudflare Agent SDK returned invalid payload');
    }

    const action = (parsed as { action?: unknown }).action;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error('Cloudflare Agent SDK response missing action');
    }

    return validateAgentAction(action);
  }
}

function validateAgentAction(action: unknown): AgentAction {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new PolicyError('invalid_action', 'Agent action must be an object');
  }

  const record = action as Record<string, unknown>;
  if (record.type === 'final') {
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) {
      throw new PolicyError('invalid_action', 'Final action requires a non-empty summary');
    }
    return { type: 'final', summary };
  }

  if (record.type !== 'tool') {
    throw new PolicyError('invalid_action', 'Action type must be tool or final');
  }

  const tool = typeof record.tool === 'string' ? record.tool : '';
  const args =
    record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? (record.args as Record<string, unknown>)
      : {};

  switch (tool) {
    case 'list_files':
      if (args.path !== undefined && typeof args.path !== 'string') {
        throw new PolicyError('invalid_action', 'list_files.path must be a string when provided');
      }
      return {
        type: 'tool',
        tool,
        args,
      } as AgentAction;
    case 'read_file':
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new PolicyError('invalid_action', 'read_file.path is required');
      }
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) {
        throw new PolicyError('invalid_action', 'read_file.maxBytes must be a number when provided');
      }
      return {
        type: 'tool',
        tool,
        args,
      } as AgentAction;
    case 'write_file':
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new PolicyError('invalid_action', 'write_file.path is required');
      }
      if (typeof args.content !== 'string') {
        throw new PolicyError('invalid_action', 'write_file.content must be a string');
      }
      return {
        type: 'tool',
        tool,
        args,
      } as AgentAction;
    case 'run_command':
      if (typeof args.command !== 'string' || !args.command.trim()) {
        throw new PolicyError('invalid_action', 'run_command.command is required');
      }
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs))) {
        throw new PolicyError('invalid_action', 'run_command.timeoutMs must be a number when provided');
      }
      return {
        type: 'tool',
        tool,
        args,
      } as AgentAction;
    case 'diff_summary':
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) {
        throw new PolicyError('invalid_action', 'diff_summary.maxBytes must be a number when provided');
      }
      return {
        type: 'tool',
        tool,
        args,
      } as AgentAction;
    default:
      throw new PolicyError('invalid_tool', `Tool '${tool}' is not supported`);
  }
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

let sandboxResolver: (env: Env, sandboxId: string) => Promise<SandboxClient> = getWorkspaceSandbox;

export function setWorkspaceTaskSandboxResolverForTests(
  resolver: ((env: Env, sandboxId: string) => Promise<SandboxClient>) | null
): void {
  sandboxResolver = resolver ?? getWorkspaceSandbox;
}

function enforceCommandPolicy(command: string, policy: TaskToolPolicy): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new PolicyError('command_not_allowed', 'Command cannot be empty');
  }

  const normalizedCommand = trimmed.toLowerCase();
  if (policy.commandDeny.some((entry) => normalizedCommand.includes(entry.toLowerCase()))) {
    throw new PolicyError('command_denied', 'Command denied by policy');
  }

  if (/[;&|`<>\n\r]/.test(trimmed) || /\$\(|\)\s*\{/.test(trimmed)) {
    throw new PolicyError('command_denied', 'Command contains denied shell metacharacters');
  }

  const allowEntries = policy.commandAllow;
  const allowed = allowEntries.some((entry) => {
    const normalizedEntry = entry.toLowerCase();
    if (normalizedEntry.includes(' ')) {
      return normalizedCommand === normalizedEntry || normalizedCommand.startsWith(`${normalizedEntry} `);
    }
    return normalizedCommand === normalizedEntry || normalizedCommand.startsWith(`${normalizedEntry} `);
  });
  if (!allowed) {
    throw new PolicyError('command_not_allowed', 'Command is not in allowlist');
  }
}

async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  timeout?: number
): Promise<{ stdout: string; stderr: string }> {
  const result = await sandbox.exec(command, { timeout });
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function executeTool(
  sandbox: SandboxClient,
  action: Extract<AgentAction, { type: 'tool' }>,
  maxCommandTimeoutMs: number,
  policy: TaskToolPolicy
): Promise<unknown> {
  if (action.tool === 'list_files') {
    const absolutePath = assertWorkspacePath(action.args.path ?? '.', policy);
    const output = await runSandboxCommand(
      sandbox,
      `python3 - ${shellQuote(absolutePath)} <<'PY'\nimport json\nimport os\nimport sys\n\npath = sys.argv[1]\nif not os.path.exists(path):\n    print(json.dumps({'error':'not_found'}))\n    raise SystemExit(0)\nentries = []\nfor name in sorted(os.listdir(path)):\n    full = os.path.join(path, name)\n    entries.append({'name': name, 'type': 'directory' if os.path.isdir(full) else 'file'})\nprint(json.dumps({'entries': entries[:500]}))\nPY`
    );
    return JSON.parse(output.stdout || '{}');
  }

  if (action.tool === 'read_file') {
    const absolutePath = assertWorkspacePath(action.args.path, policy);
    const maxBytes = parseNumber(action.args.maxBytes, 200_000, 1, 2_000_000);
    const output = await runSandboxCommand(
      sandbox,
      `python3 - ${shellQuote(absolutePath)} ${maxBytes} <<'PY'\nimport json\nimport os\nimport sys\n\npath = sys.argv[1]\nmax_bytes = int(sys.argv[2])\nif not os.path.exists(path):\n    print(json.dumps({'error':'not_found'}))\n    raise SystemExit(0)\nwith open(path, 'rb') as f:\n    data = f.read(max_bytes + 1)\ntruncated = len(data) > max_bytes\nif truncated:\n    data = data[:max_bytes]\ntext = data.decode('utf-8', errors='replace')\nprint(json.dumps({'content': text, 'truncated': truncated, 'bytes': len(data)}))\nPY`
    );
    return JSON.parse(output.stdout || '{}');
  }

  if (action.tool === 'write_file') {
    const absolutePath = assertWorkspacePath(action.args.path, policy);
    const directory = absolutePath.slice(0, absolutePath.lastIndexOf('/')) || WORKSPACE_ROOT;
    await runSandboxCommand(sandbox, `mkdir -p ${shellQuote(directory)}`);
    await sandbox.writeFile(absolutePath, action.args.content);
    return { ok: true, path: action.args.path, bytes: new TextEncoder().encode(action.args.content).length };
  }

  if (action.tool === 'run_command') {
    enforceCommandPolicy(action.args.command, policy);
    const timeout = parseNumber(action.args.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 1_000, maxCommandTimeoutMs);
    const output = await runSandboxCommand(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && ${action.args.command}`,
      timeout
    );
    return {
      stdout: output.stdout.slice(0, policy.maxOutputBytes),
      stderr: output.stderr.slice(0, policy.maxOutputBytes),
      truncated: output.stdout.length > policy.maxOutputBytes || output.stderr.length > policy.maxOutputBytes,
    };
  }

  if (action.tool === 'diff_summary') {
    const maxBytes = parseNumber(action.args.maxBytes, 128_000, 1_024, policy.maxOutputBytes);
    const output = await runSandboxCommand(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && git diff --name-status && echo '__NIMBUS_PATCH__' && git diff`
    );
    const marker = '__NIMBUS_PATCH__';
    const markerIndex = output.stdout.indexOf(marker);
    const header = markerIndex >= 0 ? output.stdout.slice(0, markerIndex).trim() : '';
    const patch = markerIndex >= 0 ? output.stdout.slice(markerIndex + marker.length).trim() : output.stdout.trim();
    return {
      changedFiles: header ? header.split(/\r?\n/).filter((line) => line.trim().length > 0) : [],
      patch: patch.length > maxBytes ? patch.slice(0, maxBytes) : patch,
      truncated: patch.length > maxBytes,
    };
  }

  throw new PolicyError('invalid_tool', 'Unsupported tool');
}

function createProvider(env: Env, payload: Record<string, unknown>, providerName: string): AgentProvider {
  if (providerName === 'scripted') {
    const allowScriptedProvider = parseBooleanString(env.WORKSPACE_AGENT_ALLOW_SCRIPTED_PROVIDER, false);
    if (!allowScriptedProvider) {
      throw new PolicyError('scripted_provider_disabled', 'Scripted provider is disabled');
    }
    const scriptedActionsRaw = payload.scriptedActions;
    if (!Array.isArray(scriptedActionsRaw)) {
      return new ScriptedAgentProvider([]);
    }
    return new ScriptedAgentProvider(scriptedActionsRaw as AgentAction[]);
  }

  if (providerName === 'cloudflare_agents_sdk') {
    const endpoint = (env.AGENT_SDK_URL ?? '').trim();
    if (!endpoint) {
      throw new Error('AGENT_SDK_URL is required for cloudflare_agents_sdk provider');
    }
    const authToken = (env.AGENT_SDK_AUTH_TOKEN ?? '').trim() || null;
    return new CloudflareAgentSdkProvider(endpoint, authToken);
  }

  throw new Error(`Unsupported agent provider: ${providerName}`);
}

async function isCancelRequested(env: Env, workspaceId: string, taskId: string): Promise<boolean> {
  const task = await getWorkspaceTask(env.DB, workspaceId, taskId);
  if (!task) {
    return true;
  }
  return Boolean(task.cancelRequestedAt);
}

async function executeWorkspaceTask(
  env: Env,
  workspaceId: string,
  task: WorkspaceTaskResponse,
  payload: Record<string, unknown>,
  toolPolicy: TaskToolPolicy
): Promise<void> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace || workspace.status !== 'ready') {
    throw new Error('Workspace is not ready for task execution');
  }

  const provider = createProvider(env, payload, task.provider);
  const sandbox = await sandboxResolver(env, workspace.sandboxId);
  const history: AgentHistoryEntry[] = [];
  const maxCommandTimeoutMs = parseIntegerString(
    env.WORKSPACE_AGENT_TIMEOUT_MS,
    toolPolicy.maxCommandTimeoutMs,
    1_000,
    toolPolicy.maxCommandTimeoutMs
  );

  await appendWorkspaceTaskEvent(env.DB, {
    workspaceId,
    taskId: task.id,
    eventType: 'task_started',
    payload: {
      provider: task.provider,
      model: task.model,
      attemptCount: task.attemptCount,
      maxSteps: task.maxSteps,
    },
  });

  for (let step = 1; step <= task.maxSteps; step += 1) {
    if (await isCancelRequested(env, workspaceId, task.id)) {
      await updateWorkspaceTaskStatus(env.DB, task.id, 'cancelled', {
        workspaceId,
        result: { reason: 'cancel_requested', step },
        errorCode: null,
        errorMessage: null,
      });
      try {
        await appendWorkspaceTaskEvent(env.DB, {
          workspaceId,
          taskId: task.id,
          eventType: 'task_cancelled',
          payload: { step },
        });
      } catch {
        // Best-effort event append after terminal status.
      }
      return;
    }

    const action = await provider.next({
      prompt: task.prompt,
      model: task.model,
      maxSteps: task.maxSteps,
      step,
      history,
    });

    if (action.type === 'final') {
      await updateWorkspaceTaskStatus(env.DB, task.id, 'succeeded', {
        workspaceId,
        result: { summary: action.summary, stepsExecuted: step - 1 },
        errorCode: null,
        errorMessage: null,
      });
      try {
        await appendWorkspaceTaskEvent(env.DB, {
          workspaceId,
          taskId: task.id,
          eventType: 'task_succeeded',
          payload: { summary: action.summary, stepsExecuted: step - 1 },
        });
      } catch {
        // Best-effort event append after terminal status.
      }
      return;
    }

    await appendWorkspaceTaskEvent(env.DB, {
      workspaceId,
      taskId: task.id,
      eventType: 'tool_call_started',
      payload: {
        step,
        tool: action.tool,
      },
    });

    const toolOutput = await executeTool(sandbox, action, maxCommandTimeoutMs, toolPolicy);
    history.push({ role: 'assistant', content: `tool:${action.tool}` });
    history.push({ role: 'tool', tool: action.tool, output: toolOutput });

    await appendWorkspaceTaskEvent(env.DB, {
      workspaceId,
      taskId: task.id,
      eventType: 'tool_call_completed',
      payload: {
        step,
        tool: action.tool,
        output: toolOutput,
      },
    });
  }

  throw new PolicyError('max_steps_exceeded', `Task exceeded maximum step count (${task.maxSteps})`);
}

export async function processWorkspaceTask(env: Env, workspaceId: string, taskId: string): Promise<void> {
  const claimed = await claimWorkspaceTaskForExecution(env.DB, workspaceId, taskId);
  if (!claimed) {
    const existing = await getWorkspaceTask(env.DB, workspaceId, taskId);
    if (existing?.status === 'running') {
      throw new QueueRetryError('Workspace task is already running; defer redelivery');
    }
    return;
  }
  let task: WorkspaceTaskResponse | null = null;
  try {
    const flags = await loadRuntimeFlags(env);
    if (!flags.workspaceAgentRuntimeEnabled) {
      await updateWorkspaceTaskStatus(env.DB, taskId, 'failed', {
        workspaceId,
        errorCode: 'workspace_agent_runtime_disabled',
        errorMessage: 'Workspace agent runtime is disabled',
      });
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_failed',
        payload: {
          code: 'workspace_agent_runtime_disabled',
          message: 'Workspace agent runtime is disabled',
        },
      });
      return;
    }

    task = await getWorkspaceTask(env.DB, workspaceId, taskId);
    if (!task) {
      return;
    }

    const payload = await getWorkspaceTaskRequestPayload(env.DB, taskId);
    const toolPolicyInput = await getWorkspaceTaskToolPolicy(env.DB, workspaceId, taskId);
    if (!payload) {
      await updateWorkspaceTaskStatus(env.DB, taskId, 'failed', {
        workspaceId,
        errorCode: 'task_not_found',
        errorMessage: 'Workspace task payload no longer exists',
      });
      return;
    }

    const toolPolicy = normalizeToolPolicy(toolPolicyInput);
    await executeWorkspaceTask(env, workspaceId, task, payload, toolPolicy);
  } catch (error) {
    const freshTask = await getWorkspaceTask(env.DB, workspaceId, taskId);
    const attemptCount = freshTask?.attemptCount ?? task?.attemptCount ?? 0;
    const maxRetries = freshTask?.maxRetries ?? task?.maxRetries ?? 0;

    if (freshTask?.cancelRequestedAt) {
      await updateWorkspaceTaskStatus(env.DB, taskId, 'cancelled', {
        workspaceId,
        result: { reason: 'cancel_requested' },
        errorCode: null,
        errorMessage: null,
      });
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_cancelled',
        payload: { reason: 'cancel_requested' },
      });
      return;
    }

    if (error instanceof PolicyError) {
      await updateWorkspaceTaskStatus(env.DB, taskId, 'failed', {
        workspaceId,
        errorCode: error.code,
        errorMessage: error.message,
      });
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_failed',
        payload: { code: error.code, message: error.message },
      });
      return;
    }

    if ((error instanceof QueueRetryError || isTransientFailure(error)) && attemptCount <= maxRetries) {
      await updateWorkspaceTaskStatus(env.DB, taskId, 'queued', {
        workspaceId,
        startedAt: null,
        finishedAt: null,
        errorCode: 'retry_scheduled',
        errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      await appendWorkspaceTaskEvent(env.DB, {
        workspaceId,
        taskId,
        eventType: 'task_retry_scheduled',
        payload: {
          attemptCount,
          maxRetries,
        },
      });
      throw new QueueRetryError('Workspace task transient failure; retry requested');
    }

    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    await updateWorkspaceTaskStatus(env.DB, taskId, 'failed', {
      workspaceId,
      errorCode: 'task_execution_failed',
      errorMessage: message,
    });
    await appendWorkspaceTaskEvent(env.DB, {
      workspaceId,
      taskId,
      eventType: 'task_failed',
      payload: {
        code: 'task_execution_failed',
        message,
      },
    });
  }
}

export function shouldRetryWorkspaceTaskError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isTransientFailure(message)) {
    return true;
  }

  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset)/i.test(message);
}
