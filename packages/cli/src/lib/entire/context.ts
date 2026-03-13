import { GitRepo } from '../checkpoint/git.js';

export interface EntireIntentContext {
  sessionIds: string[];
  note: string | null;
  transcriptUrl: string | null;
  intentSessionContext: string[];
}

export interface EntireIntentContextOptions {
  summarizeSession?: 'auto' | 'always' | 'never';
  tokenBudget?: number;
}

interface CheckpointSessionContext {
  sessionId: string;
  contextMarkdown: string;
  createdAt: string | null;
}

const ENTIRE_CHECKPOINTS_REF_PREFERENCE = [
  'entire/checkpoints/v1',
  'refs/heads/entire/checkpoints/v1',
  'refs/remotes/origin/entire/checkpoints/v1',
  'origin/entire/checkpoints/v1',
];

const ENTIRE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,160}$/;

export function isValidEntireSessionId(sessionId: string): boolean {
  return ENTIRE_SESSION_ID_REGEX.test(sessionId);
}

function isCheckpointId(value: string): boolean {
  return /^[a-f0-9]{12}$/i.test(value.trim());
}

function normalizeBranchPath(path: string): string {
  return path.replace(/^\/+/, '').trim();
}

function readJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object payload');
  }
  return parsed as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function selectEntireCheckpointsRef(refExists: (ref: string) => boolean): string | null {
  for (const ref of ENTIRE_CHECKPOINTS_REF_PREFERENCE) {
    if (refExists(ref)) {
      return ref;
    }
  }
  return null;
}

function resolveEntireCheckpointsRef(git: GitRepo): string | null {
  return selectEntireCheckpointsRef((ref) => {
    try {
      const output = git.run(['rev-parse', '--verify', '--quiet', ref]).trim();
      return Boolean(output);
    } catch {
      return false;
    }
  });
}

function listAvailableEntireCheckpointsRefs(git: GitRepo): string[] {
  return ENTIRE_CHECKPOINTS_REF_PREFERENCE.filter((ref) => {
    try {
      const output = git.run(['rev-parse', '--verify', '--quiet', ref]).trim();
      return Boolean(output);
    } catch {
      return false;
    }
  });
}

function readCheckpointSessionsFromBranch(git: GitRepo, checkpointId: string, checkpointsRef: string): CheckpointSessionContext[] {
  if (!isCheckpointId(checkpointId)) {
    return [];
  }

  const shard = checkpointId.slice(0, 2).toLowerCase();
  const suffix = checkpointId.slice(2).toLowerCase();
  const checkpointMetadataPath = `${shard}/${suffix}/metadata.json`;

  let checkpointMetadataRaw = '';
  try {
    checkpointMetadataRaw = git.run(['show', `${checkpointsRef}:${checkpointMetadataPath}`]);
  } catch {
    return [];
  }

  let checkpointMetadata: Record<string, unknown>;
  try {
    checkpointMetadata = readJsonObject(checkpointMetadataRaw);
  } catch {
    return [];
  }

  const sessions = Array.isArray(checkpointMetadata.sessions) ? checkpointMetadata.sessions : [];
  const resolved: CheckpointSessionContext[] = [];

  for (const entry of sessions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const metadataPathRaw = readOptionalString(item.metadata);
    const contextPathRaw = readOptionalString(item.context);
    if (!metadataPathRaw || !contextPathRaw) {
      continue;
    }

    const metadataPath = normalizeBranchPath(metadataPathRaw);
    const contextPath = normalizeBranchPath(contextPathRaw);

    try {
      const metadataText = git.run(['show', `${checkpointsRef}:${metadataPath}`]);
      const metadata = readJsonObject(metadataText);
      const sessionId = readOptionalString(metadata.session_id);
      if (!sessionId || !isValidEntireSessionId(sessionId)) {
        continue;
      }
      const contextMarkdown = git.run(['show', `${checkpointsRef}:${contextPath}`]);
      resolved.push({
        sessionId,
        contextMarkdown,
        createdAt: readOptionalString(metadata.created_at),
      });
    } catch {
      continue;
    }
  }

  return resolved.sort((left, right) => {
    const leftTs = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
    const rightTs = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
    if (Number.isNaN(leftTs) && Number.isNaN(rightTs)) {
      return 0;
    }
    if (Number.isNaN(leftTs)) {
      return 1;
    }
    if (Number.isNaN(rightTs)) {
      return -1;
    }
    return rightTs - leftTs;
  });
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function estimateTokenCount(lines: string[]): number {
  const chars = lines.reduce((total, line) => total + line.length, 0);
  return Math.ceil(chars / 4);
}

function rankIntentLines(lines: string[]): string[] {
  const scored = lines.map((line) => {
    let score = 0;
    if (/(do not|don't|never|must not|without)/i.test(line)) {
      score += 5;
    }
    if (/(must|required|should|prefer|use)/i.test(line)) {
      score += 4;
    }
    if (/(security|auth|token|secret|rollback|data loss|migration|breaking)/i.test(line)) {
      score += 4;
    }
    if (/(goal|intent|implement|fix|add|change)/i.test(line)) {
      score += 2;
    }
    return { line, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.line.length - b.line.length)
    .map((item) => item.line);
}

function annotateIntentLine(line: string): string {
  if (/(do not|don't|never|must not|without)/i.test(line)) {
    return `Prohibition: ${line}`;
  }
  if (/(must|required|should|prefer|use)/i.test(line)) {
    return `Constraint: ${line}`;
  }
  if (/(security|auth|token|secret|rollback|data loss|migration|breaking)/i.test(line)) {
    return `Risk focus: ${line}`;
  }
  if (/(goal|intent|implement|fix|add|change)/i.test(line)) {
    return `Goal signal: ${line}`;
  }
  return `Context: ${line}`;
}

function extractContextExcerpts(markdown: string, options: Required<EntireIntentContextOptions>): string[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .slice(0, 80);

  const excerpts: string[] = [];
  for (const line of lines) {
    const compact = compactWhitespace(line);
    if (!compact) {
      continue;
    }
    excerpts.push(compact.length > 320 ? `${compact.slice(0, 317)}...` : compact);
  }
  const fullEstimate = estimateTokenCount(excerpts);
  if (options.summarizeSession === 'never' && fullEstimate > options.tokenBudget) {
    throw new Error(
      `Entire session context exceeds token budget (${fullEstimate} > ${options.tokenBudget}). Increase --intent-token-budget or use --summarize-session auto|always.`
    );
  }

  if (options.summarizeSession === 'never' || (options.summarizeSession === 'auto' && fullEstimate <= options.tokenBudget)) {
    return excerpts.map((line) => annotateIntentLine(line));
  }

  const ranked = rankIntentLines(excerpts);
  const summarized: string[] = [];
  let runningTokens = 0;
  const maxSummaryLines = Math.max(4, Math.min(24, Math.floor(options.tokenBudget / 80)));
  for (const line of ranked) {
    const candidateLine = line.length > 180 ? `${line.slice(0, 177)}...` : line;
    const candidate = annotateIntentLine(candidateLine);
    const lineTokens = estimateTokenCount([candidate]);
    if (runningTokens + lineTokens > options.tokenBudget) {
      continue;
    }
    summarized.push(candidate);
    runningTokens += lineTokens;
    if (summarized.length >= maxSummaryLines) {
      break;
    }
  }

  if (summarized.length === 0) {
    throw new Error(
      `Unable to summarize Entire session context into token budget (${options.tokenBudget}). Split the session/commit scope or increase budget.`
    );
  }

  return summarized;
}

export async function resolveEntireIntentContextForCommit(
  commitSha: string,
  cwd = process.cwd(),
  options?: EntireIntentContextOptions & {
    checkpointId?: string | null;
  }
): Promise<EntireIntentContext> {
  const normalizedOptions: Required<EntireIntentContextOptions> = {
    summarizeSession: options?.summarizeSession ?? 'auto',
    tokenBudget: Math.max(128, Math.min(8000, Math.floor(options?.tokenBudget ?? 1200))),
  };

  let git: GitRepo;
  try {
    git = new GitRepo(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve git repository for Entire intent context: ${message}`);
  }

  const checkpointId = typeof options?.checkpointId === 'string' ? options.checkpointId.trim().toLowerCase() : null;
  if (!checkpointId || !isCheckpointId(checkpointId)) {
    throw new Error(
      `Commit ${commitSha.slice(0, 12)} does not have a valid checkpoint ID for Entire context resolution.`
    );
  }

  const availableRefs = listAvailableEntireCheckpointsRefs(git);
  if (availableRefs.length === 0) {
    throw new Error(
      'Unable to resolve Entire checkpoints branch reference (expected entire/checkpoints/v1 locally or as origin tracking ref).'
    );
  }

  let sawSessionMetadata = false;
  let lastExcerptError: Error | null = null;
  for (const checkpointsRef of availableRefs) {
    const checkpointSessions = readCheckpointSessionsFromBranch(git, checkpointId, checkpointsRef);
    if (checkpointSessions.length === 0) {
      continue;
    }
    sawSessionMetadata = true;

    for (const selectedSession of checkpointSessions) {
      let excerpts: string[] = [];
      try {
        excerpts = extractContextExcerpts(selectedSession.contextMarkdown, normalizedOptions);
      } catch (error) {
        lastExcerptError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (excerpts.length === 0) {
        continue;
      }

      return {
        sessionIds: [selectedSession.sessionId],
        note: `Review with Entire checkpoint intent context (${checkpointId}).`,
        transcriptUrl: null,
        intentSessionContext: excerpts,
      };
    }
  }

  if (sawSessionMetadata && lastExcerptError) {
    throw lastExcerptError;
  }

  throw new Error(
    `Checkpoint ${checkpointId} had no readable session metadata on any available Entire checkpoints ref (${availableRefs.join(', ')}) for commit ${commitSha.slice(0, 12)}.`
  );
}
