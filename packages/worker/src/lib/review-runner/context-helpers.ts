import type { Env } from '../../types.js';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN_PATTERN_TEST = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/;

export function stripSensitiveTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveTokenFields(item));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && GITHUB_TOKEN_PATTERN_TEST.test(value)) {
      return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]');
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, unknown>>((result, [key, nested]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'x-review-github-token' ||
      normalizedKey === 'review_context_github_token' ||
      normalizedKey === 'authorization'
    ) {
      return result;
    }
    result[key] = stripSensitiveTokenFields(nested);
    return result;
  }, {});
}

export function parseChangedPathsFromDiff(patch: string): string[] {
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

export function parseDiffHunks(patch: string): Array<{ path: string; patch: string }> {
  const lines = patch.split('\n');
  const hunks: Array<{ path: string; patch: string }> = [];
  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentPath) {
      return;
    }
    hunks.push({
      path: currentPath,
      patch: currentLines.join('\n').trim(),
    });
  };

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      flush();
      const raw = line.slice(4).trim();
      currentPath = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
      currentLines = [line];
      continue;
    }
    if (currentPath) {
      currentLines.push(line);
    }
  }

  flush();
  return hunks.filter((hunk) => hunk.path && hunk.path !== '/dev/null');
}

function parentDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const dirs = [''];
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : (parts[index] as string);
    dirs.push(current);
  }
  return dirs;
}

const CONVENTION_PATTERNS = [
  'AGENTS.md',
  'CODE_REVIEW.md',
  'CONTRIBUTING.md',
  '.editorconfig',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'biome.json',
  'biome.jsonc',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'pyproject.toml',
  'ruff.toml',
  'mypy.ini',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
] as const;

export function discoverConventionCandidates(changedPaths: string[], maxCount = 10): string[] {
  const candidates = new Set<string>();
  for (const changedPath of changedPaths) {
    const dirs = parentDirectories(changedPath);
    for (const dir of dirs) {
      for (const pattern of CONVENTION_PATTERNS) {
        const candidate = dir ? `${dir}/${pattern}` : pattern;
        candidates.add(candidate);
        if (candidates.size >= maxCount * 6) {
          return Array.from(candidates);
        }
      }
    }
  }
  return Array.from(candidates);
}

export function estimateTokenCount(parts: string[]): number {
  const chars = parts.reduce((total, part) => total + part.length, 0);
  return Math.ceil(chars / 4);
}

export function resolveReviewAnalysisModel(payload: Record<string, unknown>, env: Env): string {
  const requested = readOptionalString(payload.model);
  if (requested) {
    return requested;
  }
  const reviewModel = readOptionalString(env.REVIEW_MODEL);
  if (reviewModel) {
    return reviewModel;
  }
  const agentModel = readOptionalString(env.AGENT_MODEL);
  if (agentModel) {
    return agentModel;
  }
  return '@cf/qwen/qwen2.5-coder-32b-instruct';
}

export function mergeProvenance(
  deploymentProvenance: Record<string, unknown>,
  reviewProvenance: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...deploymentProvenance,
    ...reviewProvenance,
  };

  const deploymentSessionIds = Array.isArray(deploymentProvenance.sessionIds)
    ? deploymentProvenance.sessionIds.filter((item): item is string => typeof item === 'string')
    : [];
  const reviewSessionIds = Array.isArray(reviewProvenance.sessionIds)
    ? reviewProvenance.sessionIds.filter((item): item is string => typeof item === 'string')
    : [];
  const mergedSessionIds = Array.from(new Set([...deploymentSessionIds, ...reviewSessionIds].map((v) => v.trim()).filter(Boolean)));
  if (mergedSessionIds.length > 0) {
    merged.sessionIds = mergedSessionIds;
  }

  const deploymentIntent = Array.isArray(deploymentProvenance.intentSessionContext)
    ? deploymentProvenance.intentSessionContext.filter((item): item is string => typeof item === 'string')
    : [];
  const reviewIntent = Array.isArray(reviewProvenance.intentSessionContext)
    ? reviewProvenance.intentSessionContext.filter((item): item is string => typeof item === 'string')
    : [];
  const mergedIntent = Array.from(new Set([...deploymentIntent, ...reviewIntent].map((v) => v.trim()).filter(Boolean)));
  if (mergedIntent.length > 0) {
    merged.intentSessionContext = mergedIntent;
  }

  const deploymentRawPrompts = readOptionalString(deploymentProvenance.rawSessionPrompts);
  const reviewRawPrompts = readOptionalString(reviewProvenance.rawSessionPrompts);
  const mergedRawPrompts = reviewRawPrompts ?? deploymentRawPrompts;
  if (mergedRawPrompts) {
    merged.rawSessionPrompts = mergedRawPrompts;
  }

  return merged;
}

export function parseTouchedFilesFromMetadata(record: Record<string, unknown>): string[] {
  const candidates = [record.touchedFiles, record.touched_files, record.files_touched, record.changedFiles, record.changed_files, record.files];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const parsed = candidate
      .flatMap((item) => {
        if (typeof item === 'string') {
          return [item.trim()];
        }
        const entry = asRecord(item);
        const path = readOptionalString(entry.path);
        return path ? [path] : [];
      })
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

export function parseLocalCochangeFromProvenance(value: unknown): {
  source: 'local_git';
  checkpointsRef: string;
  lookbackSessions: number;
  topN: number;
  sessionsScanned: number;
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
} | null {
  const record = asRecord(value);
  const source = readOptionalString(record.source);
  if (source !== 'local_git') {
    return null;
  }

  const checkpointsRef = readOptionalString(record.checkpointsRef) ?? 'entire/checkpoints/v1';
  const lookbackSessions = readOptionalNumber(record.lookbackSessions);
  const topN = readOptionalNumber(record.topN);
  const sessionsScanned = readOptionalNumber(record.sessionsScanned);
  const relatedByChangedPathRaw = asRecord(record.relatedByChangedPath);

  const relatedByChangedPath = Object.entries(relatedByChangedPathRaw).reduce<
    Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>
  >((acc, [changedPath, entries]) => {
    const key = changedPath.trim();
    if (!key || !Array.isArray(entries)) {
      return acc;
    }

    const normalized = entries
      .flatMap((entry) => {
        const item = asRecord(entry);
        const path = readOptionalString(item.path);
        const frequency = readOptionalNumber(item.frequency);
        const sessionIds = uniqueStrings(parseStringArray(item.sessionIds));
        if (!path || frequency === null || frequency <= 0) {
          return [];
        }
        return [
          {
            path,
            frequency: Math.max(1, Math.floor(frequency)),
            sessionIds,
          },
        ];
      })
      .sort((left, right) => right.frequency - left.frequency)
      .slice(0, Math.max(1, Math.min(100, Math.floor(topN ?? 20))));

    acc[key] = normalized;
    return acc;
  }, {});

  return {
    source: 'local_git',
    checkpointsRef,
    lookbackSessions: Math.max(1, Math.min(50, Math.floor(lookbackSessions ?? 5))),
    topN: Math.max(1, Math.min(100, Math.floor(topN ?? 20))),
    sessionsScanned: Math.max(0, Math.floor(sessionsScanned ?? 0)),
    relatedByChangedPath,
  };
}

export function rankAggregatedRelatedPaths(
  changedPaths: string[],
  entriesByChangedPath: Map<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>,
  topN: number
): Array<{ path: string; frequency: number; sessionIds: string[] }> {
  const changedPathSet = new Set(changedPaths);
  const aggregate = new Map<
    string,
    {
      sessionIds: Set<string>;
      matchedChangedPaths: Set<string>;
      fallbackFrequency: number;
    }
  >();

  for (const changedPath of changedPaths) {
    const entries = entriesByChangedPath.get(changedPath) ?? [];
    for (const entry of entries) {
      if (changedPathSet.has(entry.path)) {
        continue;
      }
      const current = aggregate.get(entry.path) ?? {
        sessionIds: new Set<string>(),
        matchedChangedPaths: new Set<string>(),
        fallbackFrequency: 0,
      };
      for (const sessionId of entry.sessionIds) {
        current.sessionIds.add(sessionId);
      }
      current.matchedChangedPaths.add(changedPath);
      if (entry.sessionIds.length === 0) {
        current.fallbackFrequency += Math.max(1, Math.floor(entry.frequency));
      }
      aggregate.set(entry.path, current);
    }
  }

  return Array.from(aggregate.entries())
    .map(([path, value]) => ({
      path,
      frequency: value.sessionIds.size > 0 ? value.sessionIds.size : value.fallbackFrequency,
      sessionIds: Array.from(value.sessionIds).sort(),
      matchedChangedPathCount: value.matchedChangedPaths.size,
    }))
    .filter((item) => item.frequency > 0)
    .sort((left, right) => {
      if (right.frequency !== left.frequency) {
        return right.frequency - left.frequency;
      }
      if (right.matchedChangedPathCount !== left.matchedChangedPathCount) {
        return right.matchedChangedPathCount - left.matchedChangedPathCount;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, topN))
    .map(({ matchedChangedPathCount: _matchedChangedPathCount, ...item }) => item);
}
