import * as p from '@clack/prompts';
import { createWorkspace, getWorkerUrl } from '../../lib/api.js';
import {
  buildSourceBundleFilename,
  createSourceArchiveFromCommit,
} from '../../lib/checkpoint/archive.js';
import {
  buildCheckpointCreateFormData,
  buildCheckpointCreateMetadata,
} from '../../lib/checkpoint/deploy-request.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import {
  parseCommitTrailers,
  parseDeployInput,
  resolveCheckpointFromHistory,
} from '../../lib/checkpoint/resolver.js';

export interface CreateWorkspaceOptions {
  ref?: string;
  projectRoot?: string;
}

interface WorkspaceSourceSummary {
  commitSha: string;
  checkpointId: string | null;
  sourceRef: string | null;
  projectRoot: string;
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

function isValidProjectRootPath(candidatePaths: string[], normalizedProjectRoot: string): boolean {
  if (normalizedProjectRoot === '.') {
    return true;
  }

  return candidatePaths.some((path) => path.startsWith(`${normalizedProjectRoot}/`));
}

function resolveWorkspaceSource(checkpointOrCommitish: string, options: CreateWorkspaceOptions): WorkspaceSourceSummary {
  const git = new GitRepo(process.cwd());
  const parsedInput = parseDeployInput(checkpointOrCommitish);
  const sourceRef = options.ref ?? git.getCurrentBranchRef();

  let commitSha: string;
  let checkpointId: string | null = null;

  if (parsedInput.kind === 'checkpoint') {
    try {
      const commits = git.listCommits(sourceRef || 'HEAD');
      const resolved = resolveCheckpointFromHistory(parsedInput.checkpointId, commits);
      commitSha = resolved.selected.sha;
      checkpointId = resolved.selected.trailers.checkpointId;
    } catch (error) {
      if (parsedInput.explicit) {
        throw error;
      }

      commitSha = git.resolveCommitSha(checkpointOrCommitish.trim());
      checkpointId = parseCommitTrailers(git.getCommitMessage(commitSha)).checkpointId;
    }
  } else {
    commitSha = git.resolveCommitSha(parsedInput.commitish);
    checkpointId = parseCommitTrailers(git.getCommitMessage(commitSha)).checkpointId;
  }

  git.ensureNoSubmodules(commitSha);
  git.ensureNoGitLfs(commitSha);

  const treePaths = git.listTreePaths(commitSha);
  const projectRoot = normalizeRelativePath(options.projectRoot ?? '.');
  if (!isValidProjectRootPath(treePaths, projectRoot)) {
    throw new Error(`--project-root path does not exist in resolved commit: ${projectRoot}`);
  }

  return {
    commitSha,
    checkpointId,
    sourceRef,
    projectRoot,
  };
}

export async function createWorkspaceCommand(
  checkpointOrCommitish: string,
  options: CreateWorkspaceOptions
): Promise<void> {
  const spinner = p.spinner();
  spinner.start('Resolving checkpoint source...');

  try {
    const source = resolveWorkspaceSource(checkpointOrCommitish, options);
    const workerUrl = getWorkerUrl();

    if (!workerUrl) {
      throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace creation.');
    }

    spinner.message('Creating source archive from commit...');
    const sourceArchive = createSourceArchiveFromCommit(source.commitSha);

    spinner.message('Uploading source bundle and creating workspace...');
    const metadata = buildCheckpointCreateMetadata({
      checkpointId: source.checkpointId,
      commitSha: source.commitSha,
      ref: source.sourceRef ?? undefined,
      projectRoot: source.projectRoot,
      runTestsIfPresent: true,
      runLintIfPresent: true,
    });

    const formData = buildCheckpointCreateFormData(
      metadata,
      sourceArchive,
      buildSourceBundleFilename(source.commitSha)
    );

    const created = await createWorkspace(workerUrl, formData);

    spinner.stop('Workspace created');
    p.log.success(`Workspace ready: ${created.workspace.id}`);
    console.log('');
    console.log(`  Status:        ${created.workspace.status}`);
    console.log(`  Commit SHA:    ${created.workspace.commitSha}`);
    console.log(`  Checkpoint ID: ${created.workspace.checkpointId ?? 'none'}`);
    console.log(`  Project Root:  ${created.workspace.sourceProjectRoot ?? '.'}`);
    console.log(`  Sandbox ID:    ${created.workspace.sandboxId}`);
    console.log(`  Events URL:    ${created.workspace.eventsUrl}`);
  } catch (error) {
    spinner.stop('Workspace creation failed');
    throw error;
  }
}
