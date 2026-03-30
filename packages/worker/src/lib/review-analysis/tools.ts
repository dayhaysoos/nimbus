import { redactReviewText } from '../review-redaction.js';
import { asRecord } from './helpers.js';
import { clampAuthoritativeDiffSnapshot } from './prompt.js';
import { runSandboxCommand, shellQuote, type SandboxClient, WORKSPACE_ROOT } from './sandbox.js';

const DEFAULT_REVIEW_MAX_OUTPUT_BYTES = 96_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60_000;

export type ReviewAgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
  | { type: 'tool'; tool: 'write_file'; args: { path: string; content?: string } }
  | { type: 'tool'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'tool'; tool: 'diff_summary'; args: { maxBytes?: number } }
  | { type: 'final'; summary: string };

export interface ReviewCommandPolicy {
  commandAllow: string[];
  commandDeny: string[];
  maxCommandTimeoutMs: number;
  maxOutputBytes: number;
  rootPath: string;
}

export interface ReviewToolContext {
  request: Record<string, unknown>;
  result: unknown;
}

export class ReviewPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewPolicyError';
  }
}

function sanitizeToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactReviewText(value) ?? '';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, nested]) => {
      result[key] = sanitizeToolValue(nested);
      return result;
    }, {});
  }
  return value;
}

export function sanitizeToolContext(context: ReviewToolContext): ReviewToolContext {
  return {
    request: sanitizeToolValue(context.request) as Record<string, unknown>,
    result: sanitizeToolValue(context.result),
  };
}

export function buildToolHistoryLabel(action: Extract<ReviewAgentAction, { type: 'tool' }>): string {
  return `tool:${action.tool} ${JSON.stringify(action.args)}`;
}

function buildListFilesCommand(absolutePath: string, rootPath: string): string {
  return `python3 - ${shellQuote(absolutePath)} ${shellQuote(rootPath)} <<'PY'
import json
import os
import sys

path = sys.argv[1]
root = sys.argv[2]
root_real = os.path.realpath(root)
target = path if os.path.isabs(path) else os.path.join(root, path)
target_real = os.path.realpath(target)
if os.path.commonpath([root_real, target_real]) != root_real:
    print(json.dumps({'error':'path_escape'}))
    raise SystemExit(0)
if not os.path.exists(target_real):
    print(json.dumps({'error':'not_found'}))
    raise SystemExit(0)
if not os.path.isdir(target_real):
    print(json.dumps({'error':'not_directory'}))
    raise SystemExit(0)
entries = []
for name in sorted(os.listdir(target_real)):
    full = os.path.join(target_real, name)
    entries.append({'name': name, 'type': 'directory' if os.path.isdir(full) else 'file'})
print(json.dumps({'entries': entries[:200]}))
PY`;
}

function buildReadFileCommand(absolutePath: string, maxBytes: number, rootPath: string): string {
  return `python3 - ${shellQuote(absolutePath)} ${maxBytes} ${shellQuote(rootPath)} <<'PY'
import json
import os
import sys

path = sys.argv[1]
max_bytes = int(sys.argv[2])
root = sys.argv[3]
root_real = os.path.realpath(root)
target = path if os.path.isabs(path) else os.path.join(root, path)
target_real = os.path.realpath(target)
if os.path.commonpath([root_real, target_real]) != root_real:
    print(json.dumps({'error':'path_escape'}))
    raise SystemExit(0)
if not os.path.exists(target_real):
    print(json.dumps({'error':'not_found'}))
    raise SystemExit(0)
if not os.path.isfile(target_real):
    print(json.dumps({'error':'not_file'}))
    raise SystemExit(0)
with open(target_real, 'rb') as f:
    data = f.read(max_bytes + 1)
truncated = len(data) > max_bytes
if truncated:
    data = data[:max_bytes]
text = data.decode('utf-8', errors='replace')
print(json.dumps({'content': text, 'truncated': truncated, 'bytes': len(data)}))
PY`;
}

function assertWorkspacePath(pathInput: string, policy: ReviewCommandPolicy): string {
  const trimmed = (pathInput || '.').trim();
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.includes('\u0000')) {
    throw new ReviewPolicyError('Path contains null bytes');
  }
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new ReviewPolicyError('Path escapes workspace root');
  }
  const collapsed = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.').join('/');
  if (collapsed.startsWith('..')) {
    throw new ReviewPolicyError('Path escapes workspace root');
  }
  if (collapsed === '.git' || collapsed.startsWith('.git/')) {
    throw new ReviewPolicyError('Access to .git is denied by policy');
  }
  return `${policy.rootPath}/${collapsed}`;
}

export async function executeReviewTool(
  sandbox: SandboxClient,
  action: Extract<ReviewAgentAction, { type: 'tool' }>,
  policy: ReviewCommandPolicy,
  maxFileBytes: number,
  authoritativeDiffSnapshot?: unknown
): Promise<ReviewToolContext> {
  if (action.tool === 'list_files') {
    const absolutePath = assertWorkspacePath(action.args.path ?? '.', policy);
    const output = await runSandboxCommand(sandbox, buildListFilesCommand(absolutePath, policy.rootPath));
    return { request: { path: action.args.path ?? '.' }, result: JSON.parse(output.stdout || '{}') };
  }

  if (action.tool === 'read_file') {
    const absolutePath = assertWorkspacePath(action.args.path, policy);
    const maxBytes = typeof action.args.maxBytes === 'number' && Number.isFinite(action.args.maxBytes)
      ? Math.max(1, Math.min(maxFileBytes, Math.floor(action.args.maxBytes)))
      : maxFileBytes;
    const output = await runSandboxCommand(sandbox, buildReadFileCommand(absolutePath, maxBytes, policy.rootPath));
    return { request: { path: action.args.path, maxBytes }, result: JSON.parse(output.stdout || '{}') };
  }

  if (action.tool === 'run_command') {
    return {
      request: { command: action.args.command, timeoutMs: action.args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS },
      result: { error: 'run_command is disabled in review mode; use list_files, read_file, or diff_summary only', disabled: true },
    };
  }

  if (action.tool === 'write_file') {
    return {
      request: { path: action.args.path },
      result: { ok: false, error: 'write_file is disabled in review mode; use read-only tools and return findings only', path: action.args.path },
    };
  }

  if (authoritativeDiffSnapshot !== undefined) {
    const maxBytes = typeof action.args.maxBytes === 'number' && Number.isFinite(action.args.maxBytes)
      ? Math.max(1_024, Math.min(policy.maxOutputBytes, Math.floor(action.args.maxBytes)))
      : Math.min(policy.maxOutputBytes, 64_000);
    return { request: { maxBytes }, result: clampAuthoritativeDiffSnapshot(authoritativeDiffSnapshot, maxBytes) };
  }

  return {
    request: { maxBytes: typeof action.args.maxBytes === 'number' ? action.args.maxBytes : undefined },
    result: { error: 'authoritative diff snapshot unavailable', changedFiles: [], patch: '', truncated: false },
  };
}

export function validateReviewAgentAction(action: unknown): ReviewAgentAction {
  const record = asRecord(action);
  if (record.type === 'final') {
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) {
      throw new ReviewPolicyError('Final action requires a non-empty summary');
    }
    return { type: 'final', summary };
  }
  if (record.type !== 'tool') {
    throw new ReviewPolicyError('Action type must be tool or final');
  }
  const tool = typeof record.tool === 'string' ? record.tool : '';
  const args = asRecord(record.args);
  switch (tool) {
    case 'list_files':
      if (args.path !== undefined && typeof args.path !== 'string') throw new ReviewPolicyError('list_files.path must be a string when provided');
      return { type: 'tool', tool, args };
    case 'read_file':
      if (typeof args.path !== 'string' || !args.path.trim()) throw new ReviewPolicyError('read_file.path is required');
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) throw new ReviewPolicyError('read_file.maxBytes must be a number when provided');
      return { type: 'tool', tool, args: { path: args.path, maxBytes: args.maxBytes as number | undefined } };
    case 'write_file':
      if (typeof args.path !== 'string' || !args.path.trim()) throw new ReviewPolicyError('write_file.path is required');
      return { type: 'tool', tool, args: { path: args.path, content: typeof args.content === 'string' ? args.content : undefined } };
    case 'run_command':
      if (typeof args.command !== 'string' || !args.command.trim()) throw new ReviewPolicyError('run_command.command is required');
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs))) throw new ReviewPolicyError('run_command.timeoutMs must be a number when provided');
      return { type: 'tool', tool, args: { command: args.command, timeoutMs: args.timeoutMs as number | undefined } };
    case 'diff_summary':
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) throw new ReviewPolicyError('diff_summary.maxBytes must be a number when provided');
      return { type: 'tool', tool, args: { maxBytes: args.maxBytes as number | undefined } };
    default:
      throw new ReviewPolicyError(`Tool '${tool}' is not supported in review mode`);
  }
}

export async function snapshotInitialContext(sandbox: SandboxClient, maxFileBytes: number): Promise<{ rootListing: unknown; diffSnapshot: unknown }> {
  const policy: ReviewCommandPolicy = {
    commandAllow: [],
    commandDeny: [],
    maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_REVIEW_MAX_OUTPUT_BYTES,
    rootPath: WORKSPACE_ROOT,
  };

  const rootListing = await executeReviewTool(sandbox, { type: 'tool', tool: 'list_files', args: { path: '.' } }, policy, maxFileBytes);
  const diffSnapshot = await executeReviewTool(sandbox, { type: 'tool', tool: 'diff_summary', args: { maxBytes: 32_000 } }, policy, maxFileBytes);
  return { rootListing, diffSnapshot };
}
