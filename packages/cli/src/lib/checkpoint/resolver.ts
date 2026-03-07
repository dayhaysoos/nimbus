const CHECKPOINT_ID_REGEX = /^[a-f0-9]{12}$/i;

export type ParsedDeployInput =
  | { kind: 'checkpoint'; checkpointId: string; explicit: boolean }
  | { kind: 'commit'; commitish: string };

export interface ParsedTrailers {
  checkpointId: string | null;
  entireAttribution: string | null;
  entireSessionId: string | null;
}

export interface CommitHistoryEntry {
  sha: string;
  message: string;
}

export interface CheckpointResolutionFromHistory {
  selected: {
    sha: string;
    trailers: ParsedTrailers;
  };
  matchCount: number;
  matchedShas: string[];
}

export interface ProjectRootCandidate {
  path: string;
  signals: string[];
}

export interface TreeFileEntry {
  path: string;
  content?: string;
}

const LOCKFILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

const FRAMEWORK_CONFIG_REGEXES = [
  /^(next|nuxt|astro|vite|svelte|remix)\.config(\.[a-z]+)?$/,
  /^angular\.json$/,
  /^gatsby-config\.[a-z]+$/,
];

export function isCheckpointId(value: string): boolean {
  return CHECKPOINT_ID_REGEX.test(value);
}

export function parseDeployInput(input: string): ParsedDeployInput {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Missing checkpoint ID or commit-ish input');
  }

  if (raw.toLowerCase().startsWith('checkpoint:')) {
    const checkpointId = raw.slice('checkpoint:'.length).trim();
    if (!isCheckpointId(checkpointId)) {
      throw new Error('Checkpoint ID must be 12 hexadecimal characters');
    }
    return { kind: 'checkpoint', checkpointId: checkpointId.toLowerCase(), explicit: true };
  }

  if (isCheckpointId(raw)) {
    return { kind: 'checkpoint', checkpointId: raw.toLowerCase(), explicit: false };
  }

  if (raw.toLowerCase().startsWith('commit:')) {
    const commitish = raw.slice('commit:'.length).trim();
    if (!commitish) {
      throw new Error('Missing commit-ish after commit: prefix');
    }
    return { kind: 'commit', commitish };
  }

  return { kind: 'commit', commitish: raw };
}

function extractLastTrailerValue(message: string, key: 'Entire-Checkpoint' | 'Entire-Attribution'): string | null {
  const lines = message.split(/\r?\n/);
  let found: string | null = null;

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    if (match[1].toLowerCase() === key.toLowerCase()) {
      found = match[2].trim();
    }
  }

  return found;
}

export function extractEntireSessionId(entireAttribution: string | null): string | null {
  if (!entireAttribution) {
    return null;
  }

  const value = entireAttribution.trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const direct = obj.sessionId;
      if (typeof direct === 'string' && direct.trim()) {
        return direct.trim();
      }

      const snake = obj.session_id;
      if (typeof snake === 'string' && snake.trim()) {
        return snake.trim();
      }
    }
  } catch {
    // Not JSON, continue with regex extraction.
  }

  const kvMatch = value.match(/session[_-]?id\s*[:=]\s*([A-Za-z0-9_-]+)/i);
  if (kvMatch) {
    return kvMatch[1];
  }

  return null;
}

export function parseCommitTrailers(message: string): ParsedTrailers {
  const checkpointIdRaw = extractLastTrailerValue(message, 'Entire-Checkpoint');
  const checkpointId = checkpointIdRaw && isCheckpointId(checkpointIdRaw) ? checkpointIdRaw.toLowerCase() : null;
  const entireAttribution = extractLastTrailerValue(message, 'Entire-Attribution');

  return {
    checkpointId,
    entireAttribution,
    entireSessionId: extractEntireSessionId(entireAttribution),
  };
}

export function resolveCheckpointFromHistory(
  checkpointId: string,
  commitsInPriorityOrder: CommitHistoryEntry[]
): CheckpointResolutionFromHistory {
  const normalizedCheckpointId = checkpointId.toLowerCase();
  const matches: Array<{ sha: string; trailers: ParsedTrailers }> = [];

  for (const commit of commitsInPriorityOrder) {
    const trailers = parseCommitTrailers(commit.message);
    if (trailers.checkpointId === normalizedCheckpointId) {
      matches.push({ sha: commit.sha, trailers });
    }
  }

  if (matches.length === 0) {
    throw new Error(`No commit found with trailer Entire-Checkpoint: ${normalizedCheckpointId}`);
  }

  return {
    selected: matches[0],
    matchCount: matches.length,
    matchedShas: matches.map((match) => match.sha),
  };
}

export function selectProjectRoot(candidates: ProjectRootCandidate[]): ProjectRootCandidate {
  if (candidates.length === 0) {
    throw new Error('No deployable project root detected. Pass --project-root to choose a directory.');
  }

  if (candidates.length > 1) {
    const details = candidates.map((candidate) => `${candidate.path} (${candidate.signals.join(', ')})`).join('; ');
    throw new Error(
      `Multiple deployable project roots detected. Pass --project-root to disambiguate. Candidates: ${details}`
    );
  }

  return candidates[0];
}

function getDirectory(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.includes('/')) {
    return '.';
  }

  return normalized.slice(0, normalized.lastIndexOf('/'));
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

function hasBuildScript(packageJsonContent: string | undefined): boolean {
  if (!packageJsonContent) {
    return false;
  }

  try {
    const parsed = JSON.parse(packageJsonContent) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return false;
    }

    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== 'object') {
      return false;
    }

    return typeof (scripts as Record<string, unknown>).build === 'string';
  } catch {
    return false;
  }
}

export function detectProjectRootCandidates(treeFiles: TreeFileEntry[]): ProjectRootCandidate[] {
  const signalMap = new Map<string, Set<string>>();

  for (const file of treeFiles) {
    const fileName = getFileName(file.path);
    const directory = getDirectory(file.path);

    const signals = signalMap.get(directory) ?? new Set<string>();

    if (fileName === 'package.json') {
      signals.add('package_json');
      if (hasBuildScript(file.content)) {
        signals.add('build_script');
      }
    }

    if (LOCKFILE_NAMES.has(fileName)) {
      signals.add('lockfile');
    }

    if (FRAMEWORK_CONFIG_REGEXES.some((regex) => regex.test(fileName))) {
      signals.add('framework_config');
    }

    if (signals.size > 0) {
      signalMap.set(directory, signals);
    }
  }

  return Array.from(signalMap.entries())
    .filter(([, signals]) => signals.size >= 2)
    .map(([path, signals]) => ({
      path,
      signals: Array.from(signals).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
