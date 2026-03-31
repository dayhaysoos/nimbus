import { redactReviewText } from '../review-redaction.js';
import { parseTouchedFilesFromMetadata, readOptionalString } from './context-helpers.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class ReviewContextAssemblyError extends Error {
  code: string;
  details: string | null;

  constructor(code: string, message: string, details: string | null = null) {
    super(message);
    this.name = 'ReviewContextAssemblyError';
    this.code = code;
    this.details = details;
  }
}

function isCochangeCacheError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(d1_error|sqlite|sql variables|database|too many sql variables)/i.test(message);
}

function buildGitHubHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nimbus-worker/1.0',
  };
  headers.Authorization = githubToken.toLowerCase().startsWith('bearer ') ? githubToken : `Bearer ${githubToken}`;
  return headers;
}

async function fetchGitHubJson(url: string, githubToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(githubToken),
  });

  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (response.headers.get('x-ratelimit-remaining') ?? '').trim() === '0');
    const responseBody = redactReviewText(await response.text());
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}${rateLimited ? ' [rate_limited]' : ''}`,
      responseBody
    );
  }

  const data = (await response.json()) as unknown;
  return asRecord(data);
}

async function fetchGitHubArray(url: string, githubToken: string): Promise<unknown[]> {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(githubToken),
  });

  if (!response.ok) {
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (response.headers.get('x-ratelimit-remaining') ?? '').trim() === '0');
    const responseBody = redactReviewText(await response.text());
    throw new ReviewContextAssemblyError(
      'review_context_github_api_error',
      `GitHub API request failed (${response.status}) for ${url}${rateLimited ? ' [rate_limited]' : ''}`,
      responseBody
    );
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

export function classifyCochangeSkipReason(error: unknown): 'rate_limited' | 'github_api_error' | 'cache_error' {
  if (error instanceof ReviewContextAssemblyError && error.code === 'review_context_cache_error') {
    return 'cache_error';
  }
  if (error instanceof ReviewContextAssemblyError && /\[rate_limited\]/.test(error.message)) {
    return 'rate_limited';
  }
  if (isCochangeCacheError(error)) {
    return 'cache_error';
  }
  return 'github_api_error';
}

export function getCochangeCacheErrorDetails(error: unknown): string | null {
  if (!isCochangeCacheError(error)) {
    return null;
  }
  return redactReviewText(error instanceof Error ? error.message : String(error));
}

/**
 * Scans the Entire checkpoints branch metadata history on GitHub to build a simple co-change frequency map
 * for the currently changed files when no local co-change provenance is available.
 */
export async function fetchCochangeFromCheckpointBranch(
  repo: string,
  changedPaths: string[],
  lookbackSessions: number,
  githubToken: string
): Promise<{
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
  sessionsScanned: number;
}> {
  const commits = await fetchGitHubArray(
    `https://api.github.com/repos/${repo}/commits?sha=entire/checkpoints/v1&per_page=${lookbackSessions}`,
    githubToken
  );

  const frequencyByChangedPath = new Map<string, Map<string, { count: number; sessions: Set<string> }>>();
  for (const changedPath of changedPaths) {
    frequencyByChangedPath.set(changedPath, new Map());
  }
  let sessionsScanned = 0;

  for (const commit of commits.slice(0, lookbackSessions)) {
    const commitRecord = asRecord(commit);
    const sha = readOptionalString(commitRecord.sha);
    if (!sha) {
      continue;
    }

    const detail = await fetchGitHubJson(`https://api.github.com/repos/${repo}/commits/${sha}`, githubToken);
    const files = Array.isArray(detail.files) ? detail.files : [];
    const metadataPaths = files
      .map((entry) => readOptionalString(asRecord(entry).filename))
      .filter((path): path is string => Boolean(path && path.endsWith('/metadata.json')))
      .slice(0, 3);

    const touchedFiles = new Set<string>();
    for (const metadataPath of metadataPaths) {
      const file = await fetchGitHubJson(`https://api.github.com/repos/${repo}/contents/${metadataPath}?ref=${sha}`, githubToken);
      const content = readOptionalString(file.content);
      if (!content) {
        continue;
      }
      let decoded = '';
      try {
        decoded = atob(content.replace(/\n/g, ''));
      } catch {
        continue;
      }
      try {
        const metadata = JSON.parse(decoded) as unknown;
        for (const path of parseTouchedFilesFromMetadata(asRecord(metadata))) {
          touchedFiles.add(path);
        }
      } catch {
        continue;
      }
    }

    if (touchedFiles.size === 0) {
      continue;
    }

    sessionsScanned += 1;
    for (const changedPath of changedPaths) {
      if (!touchedFiles.has(changedPath)) {
        continue;
      }
      const frequency = frequencyByChangedPath.get(changedPath);
      if (!frequency) {
        continue;
      }
      for (const path of touchedFiles) {
        if (path === changedPath) {
          continue;
        }
        const next = frequency.get(path) ?? { count: 0, sessions: new Set<string>() };
        next.count += 1;
        next.sessions.add(sha);
        frequency.set(path, next);
      }
    }
  }

  const relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>> = {};
  for (const changedPath of changedPaths) {
    const frequency = frequencyByChangedPath.get(changedPath) ?? new Map<string, { count: number; sessions: Set<string> }>();
    relatedByChangedPath[changedPath] = Array.from(frequency.entries())
      .map(([path, value]) => ({
        path,
        frequency: value.count,
        sessionIds: Array.from(value.sessions),
      }))
      .sort((left, right) => right.frequency - left.frequency);
  }

  return {
    relatedByChangedPath,
    sessionsScanned,
  };
}
