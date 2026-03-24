import { GitRepo } from '../checkpoint/git.js';

export interface EntireIntentContext {
  sessionIds: string[];
  note: string | null;
  transcriptUrl: string | null;
  intentSessionContext: string[];
  rawSessionPrompts?: string | null;
}

export interface EntireIntentContextOptions {
  summarizeSession?: 'auto' | 'always' | 'never';
  tokenBudget?: number;
}

export interface EntireCochangeEntry {
  path: string;
  frequency: number;
  sessionIds: string[];
}

export interface EntireLocalCochangeResolution {
  source: 'local_git';
  checkpointsRef: string;
  lookbackSessions: number;
  topN: number;
  sessionsScanned: number;
  relatedByChangedPath: Record<string, EntireCochangeEntry[]>;
}

interface CheckpointSessionContext {
  sessionId: string;
  contextText: string;
  rawPromptText: string | null;
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

function parseTouchedFilesFromSessionMetadata(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.touchedFiles,
    record.touched_files,
    record.files_touched,
    record.changedFiles,
    record.changed_files,
    record.files,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const parsed = candidate
      .flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry.trim()];
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }
        const item = entry as Record<string, unknown>;
        const path = readOptionalString(item.path);
        return path ? [path] : [];
      })
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function parseChangedPathsFromDiff(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ ')) {
      continue;
    }
    const raw = line.slice(4).trim();
    if (!raw || raw === '/dev/null') {
      continue;
    }
    const normalized = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '/dev/null') {
      continue;
    }
    paths.add(normalized);
  }
  return Array.from(paths);
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

function scoreIntentLineAgainstChangedPaths(line: string, changedPaths: string[]): number {
  const normalizedLine = line.toLowerCase();
  let score = 0;

  for (const changedPath of changedPaths) {
    const normalizedPath = changedPath.toLowerCase();
    if (normalizedLine.includes(normalizedPath)) {
      score += 8;
      continue;
    }
    const fileName = basename(normalizedPath);
    if (fileName && fileName.length > 3 && normalizedLine.includes(fileName)) {
      score += 3;
    }
  }

  if (/^(prohibition|constraint|goal signal)\s*:/i.test(line)) {
    score += 2;
  }
  if (/\b(do not|don't|must not|never|avoid|prefer|require|should)\b/i.test(line)) {
    score += 1;
  }
  if (/\b(run\s+git\s+diff|usage:|step\s+\d+|command:)\b/i.test(line)) {
    score -= 3;
  }

  return score;
}

export function selectRelevantIntentContextLines(
  lines: string[],
  changedPaths: string[],
  options?: { maxLines?: number }
): string[] {
  const maxLines = Math.max(8, Math.min(80, Math.floor(options?.maxLines ?? 40)));
  const normalizedPaths = Array.from(new Set(changedPaths.map((path) => path.trim()).filter(Boolean)));
  const scored = lines
    .map((line, index) => ({
      line,
      index,
      score: scoreIntentLineAgainstChangedPaths(line, normalizedPaths),
    }))
    .filter((entry) => entry.line.trim());

  const withPositiveScore = scored.filter((entry) => entry.score > 0);
  const target = withPositiveScore.length > 0 ? withPositiveScore : scored;
  const prioritized = target
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxLines)
    .map((entry) => entry.line.trim())
    .filter(Boolean);

  return Array.from(new Set(prioritized));
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

export function resolveCochangeFromLocalGit(
  changedPathsInput: string[] | string,
  cwd = process.cwd(),
  options?: {
    lookbackSessions?: number;
    topN?: number;
  }
): EntireLocalCochangeResolution | null {
  const lookbackSessions = Math.max(1, Math.min(50, Math.floor(options?.lookbackSessions ?? 5)));
  const topN = Math.max(1, Math.min(100, Math.floor(options?.topN ?? 20)));

  const changedPaths = Array.from(
    new Set(
      (Array.isArray(changedPathsInput) ? changedPathsInput : parseChangedPathsFromDiff(changedPathsInput))
        .map((path) => path.trim())
        .filter(Boolean)
    )
  );

  if (changedPaths.length === 0) {
    return {
      source: 'local_git',
      checkpointsRef: 'entire/checkpoints/v1',
      lookbackSessions,
      topN,
      sessionsScanned: 0,
      relatedByChangedPath: {},
    };
  }

  const git = new GitRepo(cwd);
  const checkpointsRef = resolveEntireCheckpointsRef(git);
  if (!checkpointsRef) {
    return null;
  }

  const commits = git.listCommits(checkpointsRef).slice(0, Math.max(lookbackSessions * 4, lookbackSessions));
  const sessionRecords: Array<{ sessionId: string; touchedFiles: Set<string> }> = [];

  for (const commit of commits) {
    if (sessionRecords.length >= lookbackSessions) {
      break;
    }
    let changedFilesOutput = '';
    try {
      changedFilesOutput = git.run(['show', '--name-only', '--format=', commit.sha]);
    } catch {
      continue;
    }
    const metadataPaths = changedFilesOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((path) => path.endsWith('/metadata.json'))
      .slice(0, 3);

    for (const metadataPath of metadataPaths) {
      if (sessionRecords.length >= lookbackSessions) {
        break;
      }
      let metadataRaw = '';
      try {
        metadataRaw = git.run(['show', `${commit.sha}:${metadataPath}`]);
      } catch {
        continue;
      }

      let metadata: Record<string, unknown>;
      try {
        metadata = readJsonObject(metadataRaw);
      } catch {
        continue;
      }

      const touchedFiles = parseTouchedFilesFromSessionMetadata(metadata);
      if (touchedFiles.length === 0) {
        continue;
      }

      const metadataSessionId = readOptionalString(metadata.session_id);
      const sessionId = metadataSessionId && isValidEntireSessionId(metadataSessionId) ? metadataSessionId : commit.sha;
      sessionRecords.push({
        sessionId,
        touchedFiles: new Set(touchedFiles),
      });
    }
  }

  if (sessionRecords.length === 0) {
    return null;
  }

  const frequencyByChangedPath = new Map<string, Map<string, { count: number; sessions: Set<string> }>>();
  for (const changedPath of changedPaths) {
    frequencyByChangedPath.set(changedPath, new Map());
  }

  for (const session of sessionRecords) {
    for (const changedPath of changedPaths) {
      if (!session.touchedFiles.has(changedPath)) {
        continue;
      }
      const frequency = frequencyByChangedPath.get(changedPath);
      if (!frequency) {
        continue;
      }
      for (const touchedPath of session.touchedFiles) {
        if (touchedPath === changedPath) {
          continue;
        }
        const next = frequency.get(touchedPath) ?? { count: 0, sessions: new Set<string>() };
        next.count += 1;
        next.sessions.add(session.sessionId);
        frequency.set(touchedPath, next);
      }
    }
  }

  const relatedByChangedPath: Record<string, EntireCochangeEntry[]> = {};
  for (const changedPath of changedPaths) {
    const frequency = frequencyByChangedPath.get(changedPath) ?? new Map<string, { count: number; sessions: Set<string> }>();
    relatedByChangedPath[changedPath] = Array.from(frequency.entries())
      .map(([path, value]) => ({
        path,
        frequency: value.count,
        sessionIds: Array.from(value.sessions),
      }))
      .sort((left, right) => right.frequency - left.frequency)
      .slice(0, topN);
  }

  return {
    source: 'local_git',
    checkpointsRef,
    lookbackSessions,
    topN,
    sessionsScanned: sessionRecords.length,
    relatedByChangedPath,
  };
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
    const promptPathRaw = readOptionalString(item.prompt);
    if (!metadataPathRaw || (!contextPathRaw && !promptPathRaw)) {
      continue;
    }

    const metadataPath = normalizeBranchPath(metadataPathRaw);
    const contextPath = contextPathRaw ? normalizeBranchPath(contextPathRaw) : null;
    const promptPath = promptPathRaw ? normalizeBranchPath(promptPathRaw) : null;

    try {
      const metadataText = git.run(['show', `${checkpointsRef}:${metadataPath}`]);
      const metadata = readJsonObject(metadataText);
      const sessionId = readOptionalString(metadata.session_id);
      if (!sessionId || !isValidEntireSessionId(sessionId)) {
        continue;
      }

      let contextText = '';
      if (contextPath) {
        try {
          contextText = git.run(['show', `${checkpointsRef}:${contextPath}`]);
        } catch {
          contextText = '';
        }
      }

      let rawPromptText: string | null = null;
      if (promptPath) {
        try {
          const promptText = git.run(['show', `${checkpointsRef}:${promptPath}`]);
          rawPromptText = promptText.trim() ? promptText : null;
        } catch {
          rawPromptText = null;
        }
      }

      if (!contextText.trim() && rawPromptText) {
        contextText = rawPromptText;
      }
      if (!contextText.trim()) {
        continue;
      }

      resolved.push({
        sessionId,
        contextText,
        rawPromptText,
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
    return excerpts;
  }

  const ranked = rankIntentLines(excerpts);
  const summarized: string[] = [];
  let runningTokens = 0;
  const maxSummaryLines = Math.max(4, Math.min(24, Math.floor(options.tokenBudget / 80)));
  for (const line of ranked) {
    const candidateLine = line.length > 180 ? `${line.slice(0, 177)}...` : line;
    const candidate = candidateLine;
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

function extractRawUserPrompts(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inUserPromptsSection = false;
  let inPromptBlock = false;
  const promptBlocks: string[] = [];
  let currentBlockLines: string[] = [];

  const flushBlock = () => {
    if (currentBlockLines.length === 0) {
      return;
    }
    const blockText = compactWhitespace(currentBlockLines.join(' '));
    if (blockText) {
      promptBlocks.push(blockText);
    }
    currentBlockLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+User Prompts\s*$/i.test(line)) {
      flushBlock();
      inUserPromptsSection = true;
      inPromptBlock = false;
      continue;
    }

    if (inUserPromptsSection && /^##\s+/.test(line) && !/^##\s+User Prompts\s*$/i.test(line)) {
      flushBlock();
      inUserPromptsSection = false;
      inPromptBlock = false;
      continue;
    }

    if (!inUserPromptsSection) {
      continue;
    }

    if (/^###\s+Prompt\b/i.test(line)) {
      flushBlock();
      inPromptBlock = true;
      continue;
    }

    if (!inPromptBlock) {
      continue;
    }

    if (!line || line.startsWith('#')) {
      continue;
    }

    currentBlockLines.push(line);
  }

  flushBlock();

  if (promptBlocks.length === 0) {
    return null;
  }

  const joined = promptBlocks.join('\n\n').trim();
  if (!joined) {
    return null;
  }

  return joined.length > 6000 ? `${joined.slice(0, 5997)}...` : joined;
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
        excerpts = extractContextExcerpts(selectedSession.contextText, normalizedOptions);
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
        rawSessionPrompts: selectedSession.rawPromptText ?? extractRawUserPrompts(selectedSession.contextText),
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
