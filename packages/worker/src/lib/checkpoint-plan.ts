export type CheckpointPackageManager = 'npm' | 'bun';

export interface CheckpointExecutionPlan {
  install: string;
  build: string | null;
  test: string | null;
  lint: string | null;
}

export function normalizeProjectRoot(sourceProjectRoot: string | null | undefined): string {
  if (!sourceProjectRoot || sourceProjectRoot === '.') {
    return '.';
  }

  const slashNormalized = sourceProjectRoot.replace(/\\/g, '/').trim();
  if (/^\/+$/u.test(slashNormalized)) {
    throw new Error('projectRoot must be a relative directory path');
  }

  const normalized = slashNormalized.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) {
    return '.';
  }

  if (normalized.startsWith('/')) {
    throw new Error('projectRoot must be a relative directory path');
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error('projectRoot contains invalid path traversal segments');
    }
  }

  return normalized;
}

export function resolveProjectDir(sourceRoot: string, sourceProjectRoot: string | null | undefined): string {
  const normalizedProjectRoot = normalizeProjectRoot(sourceProjectRoot);
  if (normalizedProjectRoot === '.') {
    return sourceRoot;
  }

  return `${sourceRoot}/${normalizedProjectRoot}`;
}

export function detectPackageManager(lockfiles: string[]): CheckpointPackageManager {
  const fileSet = new Set(lockfiles);

  if (fileSet.has('bun.lock') || fileSet.has('bun.lockb')) {
    return 'bun';
  }

  if (fileSet.has('package-lock.json')) {
    return 'npm';
  }

  if (fileSet.has('pnpm-lock.yaml')) {
    throw new Error('pnpm lockfile detected but pnpm is not supported yet for checkpoint execution');
  }

  if (fileSet.has('yarn.lock')) {
    throw new Error('yarn lockfile detected but yarn is not supported yet for checkpoint execution');
  }

  throw new Error('No lockfile found. Checkpoint execution requires lockfile-based deterministic install.');
}

function installCommand(packageManager: CheckpointPackageManager): string {
  if (packageManager === 'bun') {
    return 'bun install --frozen-lockfile --ignore-scripts';
  }

  return 'npm ci --include=dev --ignore-scripts --no-audit --no-fund';
}

function runScriptCommand(packageManager: CheckpointPackageManager, scriptName: string): string {
  if (packageManager === 'bun') {
    return `bun run ${scriptName}`;
  }

  return `npm run ${scriptName}`;
}

export function buildCheckpointExecutionPlan(input: {
  packageManager: CheckpointPackageManager;
  scripts: Record<string, string>;
  runTestsIfPresent: boolean;
  runLintIfPresent: boolean;
}): CheckpointExecutionPlan {
  const hasBuild = typeof input.scripts.build === 'string';
  const hasTest = typeof input.scripts.test === 'string';
  const hasLint = typeof input.scripts.lint === 'string';

  return {
    install: installCommand(input.packageManager),
    build: hasBuild ? runScriptCommand(input.packageManager, 'build') : null,
    test: input.runTestsIfPresent && hasTest ? runScriptCommand(input.packageManager, 'test') : null,
    lint: input.runLintIfPresent && hasLint ? runScriptCommand(input.packageManager, 'lint') : null,
  };
}
