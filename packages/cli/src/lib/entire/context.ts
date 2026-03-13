import { access, readFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { join, resolve as resolvePath, sep as pathSep } from 'path';
import { GitRepo } from '../checkpoint/git.js';
import { parseCommitTrailers } from '../checkpoint/resolver.js';

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

const ENTIRE_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,160}$/;

export function isValidEntireSessionId(sessionId: string): boolean {
  return ENTIRE_SESSION_ID_REGEX.test(sessionId);
}

function resolveContextPath(metadataRoot: string, sessionId: string): string {
  const root = resolvePath(metadataRoot);
  const candidate = resolvePath(root, sessionId, 'context.md');
  if (candidate !== root && !candidate.startsWith(`${root}${pathSep}`)) {
    throw new Error('Entire session path escaped expected metadata directory');
  }
  return candidate;
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveEntireIntentContextForCommit(
  commitSha: string,
  cwd = process.cwd(),
  options?: EntireIntentContextOptions
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

  let message = '';
  try {
    message = git.getCommitMessage(commitSha);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read commit message for ${commitSha.slice(0, 12)}: ${msg}`);
  }

  const trailers = parseCommitTrailers(message);
  const sessionId = trailers.entireSessionId;
  if (!sessionId) {
    throw new Error(
      `Commit ${commitSha.slice(0, 12)} is missing Entire session attribution. Include Entire-Attribution trailer before deploy/review.`
    );
  }
  if (!isValidEntireSessionId(sessionId)) {
    throw new Error(
      `Commit ${commitSha.slice(0, 12)} has invalid Entire session attribution format. Expected [A-Za-z0-9_-] and max length 160.`
    );
  }

  const repoRoot = git.getRepoRoot();
  const metadataRoots = [
    join(repoRoot, '.entire', 'metadata'),
    join(repoRoot, '.opencode', 'entire', 'metadata'),
  ];
  const candidatePaths = [
    resolveContextPath(metadataRoots[0], sessionId),
    resolveContextPath(metadataRoots[1], sessionId),
  ];
  const contextPath = (await Promise.all(candidatePaths.map(async (path) => ((await fileExists(path)) ? path : null)))).find(Boolean);
  if (!contextPath) {
    throw new Error(
      `Entire session context file is missing for ${sessionId}. Expected one of: ${candidatePaths.join(', ')}`
    );
  }

  let contextMarkdown = '';
  try {
    contextMarkdown = await readFile(contextPath, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Entire context file ${contextPath}: ${msg}`);
  }
  const excerpts = extractContextExcerpts(contextMarkdown, normalizedOptions);
  if (excerpts.length === 0) {
    throw new Error(`Entire context file ${contextPath} did not yield usable intent context excerpts.`);
  }

  return {
    sessionIds: [sessionId],
    note: `Review with Entire session intent context (${sessionId}).`,
    transcriptUrl: null,
    intentSessionContext: excerpts,
  };
}
