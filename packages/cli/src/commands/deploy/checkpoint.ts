import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import * as p from '@clack/prompts';
import { createCheckpointJob, getWorkerUrl } from '../../lib/api.js';
import {
  buildSourceBundleFilename,
  createSourceArchiveFromCommit,
} from '../../lib/checkpoint/archive.js';
import {
  buildCheckpointCreateFormData,
  buildCheckpointCreateMetadata,
} from '../../lib/checkpoint/deploy-request.js';
import {
  collectEnvTemplates,
  computeEnvFingerprint,
  isEnvTemplatePath,
  isLocalEnvPath,
  parseEnvFileContent,
  resolveEnvPreflight,
} from '../../lib/checkpoint/env.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import {
  detectProjectRootCandidates,
  parseCommitTrailers,
  parseDeployInput,
  resolveCheckpointFromHistory,
  selectProjectRoot,
} from '../../lib/checkpoint/resolver.js';
import type { DeployCheckpointOptions } from './checkpoint-options.js';

interface DryRunSummary {
  input: string;
  resolvedKind: 'checkpoint' | 'commit';
  checkpointId: string | null;
  commitSha: string;
  branchRef: string | null;
  entireSessionId: string | null;
  hasEntireAttribution: boolean;
  projectRoot: string;
  runTestsIfPresent: boolean;
  runLintIfPresent: boolean;
  templatePaths: string[];
  loadedLocalEnvFiles: string[];
  requiredEnvKeys: string[];
  optionalEnvKeys: string[];
  missingRequiredKeys: string[];
  resolvedEnvKeys: string[];
  envFingerprint: string;
  checkpointMatchCount?: number;
}

function assertRequiredEnvKeysResolved(summary: DryRunSummary): void {
  if (summary.missingRequiredKeys.length > 0) {
    throw new Error(`Missing required environment keys: ${summary.missingRequiredKeys.join(', ')}`);
  }
}

function normalizeRelativePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '.') {
    return '.';
  }

  const noLeadingDot = trimmed.replace(/^\.\//, '');
  const normalized = noLeadingDot.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '.';
}

export function isValidProjectRootPath(candidatePaths: string[], normalizedProjectRoot: string): boolean {
  if (normalizedProjectRoot === '.') {
    return true;
  }

  return candidatePaths.some((path) => path.startsWith(`${normalizedProjectRoot}/`));
}

export function getAutoEnvDiscoveryDirectories(repoRoot: string, projectRoot: string): string[] {
  const projectRootAbsolute = resolve(repoRoot, projectRoot);
  return Array.from(new Set([repoRoot, projectRootAbsolute]));
}

export function resolveEnvFileLoadOrder(input: {
  autoDiscoveredFiles: string[];
  explicitFiles: string[];
}): string[] {
  const ordered: string[] = [];

  const pushUnique = (filePath: string): void => {
    if (!ordered.includes(filePath)) {
      ordered.push(filePath);
    }
  };

  for (const filePath of input.autoDiscoveredFiles) {
    pushUnique(filePath);
  }

  for (const filePath of input.explicitFiles) {
    pushUnique(filePath);
  }

  return ordered;
}

function readLocalEnvFiles(repoRoot: string, projectRoot: string, explicitEnvFiles: string[]): {
  loadedFiles: string[];
  values: Map<string, string>;
} {
  const cwd = process.cwd();
  const directories = new Set<string>(getAutoEnvDiscoveryDirectories(repoRoot, projectRoot));
  const autoDiscoveredFiles: string[] = [];

  for (const directory of directories) {
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (isLocalEnvPath(entry)) {
        autoDiscoveredFiles.push(resolve(directory, entry));
      }
    }
  }

  const explicitFiles: string[] = [];
  for (const envFile of explicitEnvFiles) {
    const absolutePath = resolve(cwd, envFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing --env-file path: ${envFile}`);
    }
    explicitFiles.push(absolutePath);
  }

  const sortedAutoDiscoveredFiles = Array.from(new Set(autoDiscoveredFiles)).sort((a, b) => a.localeCompare(b));
  const orderedFiles = resolveEnvFileLoadOrder({
    autoDiscoveredFiles: sortedAutoDiscoveredFiles,
    explicitFiles,
  })
    .filter((path) => existsSync(path))
    .filter((path, index, allPaths) => allPaths.indexOf(path) === index);

  const mergedValues = new Map<string, string>();
  for (const filePath of orderedFiles) {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseEnvFileContent(content);
    for (const [key, value] of parsed.entries()) {
      mergedValues.set(key, value);
    }
  }

  return {
    loadedFiles: orderedFiles,
    values: mergedValues,
  };
}

function mapProcessEnv(): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      values.set(key, value);
    }
  }
  return values;
}

function resolveProjectRoot(
  candidatePaths: string[],
  candidates: ReturnType<typeof detectProjectRootCandidates>,
  explicitProjectRoot: string | undefined
): string {
  if (explicitProjectRoot) {
    const normalizedProjectRoot = normalizeRelativePath(explicitProjectRoot);

    const hasPathInTree = isValidProjectRootPath(candidatePaths, normalizedProjectRoot);

    if (!hasPathInTree) {
      throw new Error(`--project-root path does not exist in resolved commit: ${normalizedProjectRoot}`);
    }

    return normalizedProjectRoot;
  }

  const selected = selectProjectRoot(candidates);
  return selected.path;
}

function buildDryRunSummary(input: string, options: DeployCheckpointOptions): DryRunSummary {
  const git = new GitRepo(process.cwd());
  const repoRoot = git.getRepoRoot();
  const normalizedInput = input.trim();
  const parsedInput = parseDeployInput(input);
  const branchRef = git.getCurrentBranchRef();
  let resolvedKind: 'checkpoint' | 'commit' = parsedInput.kind;

  let commitSha: string;
  let checkpointId: string | null = null;
  let trailers: ReturnType<typeof parseCommitTrailers>;
  let checkpointMatchCount: number | undefined;

  if (parsedInput.kind === 'checkpoint') {
    try {
      const ref = options.ref || 'HEAD';
      const commits = git.listCommits(ref);
      const resolved = resolveCheckpointFromHistory(parsedInput.checkpointId, commits);
      commitSha = resolved.selected.sha;
      checkpointId = resolved.selected.trailers.checkpointId;
      trailers = resolved.selected.trailers;
      checkpointMatchCount = resolved.matchCount;
    } catch (error) {
      if (parsedInput.explicit) {
        throw error;
      }

      commitSha = git.resolveCommitSha(normalizedInput);
      trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
      checkpointId = trailers.checkpointId;
      resolvedKind = 'commit';
    }
  } else {
    commitSha = git.resolveCommitSha(parsedInput.commitish);
    trailers = parseCommitTrailers(git.getCommitMessage(commitSha));
    checkpointId = trailers.checkpointId;
  }

  git.ensureNoSubmodules(commitSha);
  git.ensureNoGitLfs(commitSha);

  const treePaths = git.listTreePaths(commitSha);
  const treeEntries = git.listTreeFileEntriesForProjectDetection(commitSha);
  const projectRootCandidates = detectProjectRootCandidates(treeEntries);
  const projectRoot = resolveProjectRoot(treePaths, projectRootCandidates, options.projectRoot);

  const templatePaths = treePaths.filter((path) => isEnvTemplatePath(path));
  const templateFiles = templatePaths.map((path) => ({
    path,
    content: git.readFileAtCommit(commitSha, path),
  }));
  const templateSpec = collectEnvTemplates(templateFiles);

  const localEnv = readLocalEnvFiles(repoRoot, projectRoot, options.envFiles);
  const envResolution = resolveEnvPreflight({
    requiredKeys: templateSpec.requiredKeys,
    optionalKeys: templateSpec.optionalKeys,
    explicitEnv: options.explicitEnv,
    localEnv: localEnv.values,
    processEnv: mapProcessEnv(),
  });

  const fingerprintInput = new Map<string, string>();
  for (const [key, value] of envResolution.values.entries()) {
    fingerprintInput.set(key, value.value);
  }

  return {
    input,
    resolvedKind,
    checkpointId,
    commitSha,
    branchRef,
    entireSessionId: trailers.entireSessionId,
    hasEntireAttribution: Boolean(trailers.entireAttribution),
    projectRoot,
    runTestsIfPresent: options.runTestsIfPresent,
    runLintIfPresent: options.runLintIfPresent,
    templatePaths: templatePaths.sort((a, b) => a.localeCompare(b)),
    loadedLocalEnvFiles: localEnv.loadedFiles,
    requiredEnvKeys: templateSpec.requiredKeys,
    optionalEnvKeys: templateSpec.optionalKeys,
    missingRequiredKeys: envResolution.missingRequiredKeys,
    resolvedEnvKeys: Array.from(envResolution.values.keys()).sort((a, b) => a.localeCompare(b)),
    envFingerprint: computeEnvFingerprint(fingerprintInput),
    checkpointMatchCount,
  };
}

function printDryRunSummary(summary: DryRunSummary): void {
  p.log.info('Checkpoint deployment dry run');
  console.log('');
  console.log(`  Source:           ${summary.resolvedKind}`);
  console.log(`  Input:            ${summary.input}`);
  console.log(`  Commit SHA:       ${summary.commitSha}`);
  console.log(`  Checkpoint ID:    ${summary.checkpointId ?? 'none'}`);
  console.log(`  Branch Ref:       ${summary.branchRef ?? 'detached HEAD'}`);
  console.log(`  Entire Session:   ${summary.entireSessionId ?? 'not found'}`);
  console.log(`  Attribution:      ${summary.hasEntireAttribution ? 'present' : 'none'}`);
  console.log(`  Project Root:     ${summary.projectRoot}`);
  console.log(`  Run Tests:        ${summary.runTestsIfPresent ? 'yes' : 'no'}`);
  console.log(`  Run Lint:         ${summary.runLintIfPresent ? 'yes' : 'no'}`);
  console.log(`  Env Templates:    ${summary.templatePaths.length}`);
  console.log(`  Env Files Loaded: ${summary.loadedLocalEnvFiles.length}`);
  console.log(`  Env Keys Found:   ${summary.resolvedEnvKeys.length}`);
  console.log(`  Env Fingerprint:  ${summary.envFingerprint}`);

  if (summary.checkpointMatchCount && summary.checkpointMatchCount > 1) {
    p.log.warning(
      `Multiple commits matched this checkpoint trailer (${summary.checkpointMatchCount}); selected newest reachable commit.`
    );
  }

  if (summary.templatePaths.length > 0) {
    p.log.info(`Template files: ${summary.templatePaths.join(', ')}`);
  }

  if (summary.loadedLocalEnvFiles.length > 0) {
    const localEnvDisplay = summary.loadedLocalEnvFiles
      .map((path) => normalizeRelativePath(path.replace(`${process.cwd()}/`, '')))
      .join(', ');
    p.log.info(`Local env files: ${localEnvDisplay}`);
  }

  if (summary.requiredEnvKeys.length > 0) {
    p.log.info(`Required env keys: ${summary.requiredEnvKeys.join(', ')}`);
  }

  if (summary.optionalEnvKeys.length > 0) {
    p.log.info(`Optional env keys: ${summary.optionalEnvKeys.join(', ')}`);
  }

  assertRequiredEnvKeysResolved(summary);

  p.log.success('Dry run succeeded. Source resolution and env preflight are valid.');
  p.log.info('Run again with --no-dry-run to upload source and queue a live checkpoint job.');
}

function printQueuedCheckpointSummary(
  summary: DryRunSummary,
  created: {
    jobId: string;
    status: string;
    phase: string;
    eventsUrl: string;
    jobUrl: string;
  }
): void {
  p.log.success(`Checkpoint job queued: ${created.jobId}`);
  console.log('');
  console.log(`  Status:         ${created.status}`);
  console.log(`  Phase:          ${created.phase}`);
  console.log(`  Commit SHA:     ${summary.commitSha}`);
  console.log(`  Checkpoint ID:  ${summary.checkpointId ?? 'none'}`);
  console.log(`  Project Root:   ${summary.projectRoot}`);
  console.log(`  Job URL:        ${created.jobUrl}`);
  console.log(`  Events URL:     ${created.eventsUrl}`);
}

export async function deployCheckpointCommand(
  checkpointOrCommitish: string,
  options: DeployCheckpointOptions
): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Resolving checkpoint source and validating environment...');

  try {
    const summary = buildDryRunSummary(checkpointOrCommitish, options);

    if (options.dryRun) {
      spinner.stop('Dry run complete');
      printDryRunSummary(summary);
      return;
    }

    assertRequiredEnvKeysResolved(summary);

    const workerUrl = getWorkerUrl();
    if (!workerUrl) {
      throw new Error('NIMBUS_WORKER_URL environment variable is required for checkpoint job creation.');
    }

    spinner.message('Creating source archive from commit...');
    const sourceArchive = createSourceArchiveFromCommit(summary.commitSha);

    spinner.message('Uploading source bundle and creating checkpoint job...');
    const metadata = buildCheckpointCreateMetadata({
      checkpointId: summary.checkpointId,
      commitSha: summary.commitSha,
      ref: options.ref ?? summary.branchRef ?? undefined,
      projectRoot: summary.projectRoot,
      runTestsIfPresent: options.runTestsIfPresent,
      runLintIfPresent: options.runLintIfPresent,
    });

    const formData = buildCheckpointCreateFormData(
      metadata,
      sourceArchive,
      buildSourceBundleFilename(summary.commitSha)
    );

    const created = await createCheckpointJob(workerUrl, formData);

    spinner.stop('Checkpoint job created');
    printQueuedCheckpointSummary(summary, created);

    if (options.watch) {
      p.log.info('Checkpoint watch currently polls job status (SSE event rendering is limited).');
      p.log.info(`You can poll status now: nimbus watch ${created.jobId}`);
    }
  } catch (error) {
    spinner.stop('Checkpoint deploy failed');
    throw error;
  }
}
