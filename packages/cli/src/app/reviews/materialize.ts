import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { getReviewSession } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import {
  createWorkspacePatchExport,
  downloadWorkspaceArtifact,
  getWorkspaceOperation,
  listWorkspaceArtifacts,
} from '../../clients/worker/workspaces.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import type {
  ReviewEnvironmentRevision,
  ReviewSessionResponse,
  WorkspaceArtifactResponse,
  WorkspaceOperationResponse,
} from '../../lib/types.js';
import { sleep } from './create-shared.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_SETTLE_TIMEOUT_MS = 120_000;

let getReviewSessionForFlow: typeof getReviewSession = getReviewSession;
let createWorkspacePatchExportForFlow: typeof createWorkspacePatchExport = createWorkspacePatchExport;
let getWorkspaceOperationForFlow: typeof getWorkspaceOperation = getWorkspaceOperation;
let listWorkspaceArtifactsForFlow: typeof listWorkspaceArtifacts = listWorkspaceArtifacts;
let downloadWorkspaceArtifactForFlow: typeof downloadWorkspaceArtifact = downloadWorkspaceArtifact;

export function setReviewSessionMaterializeFlowForTests(
  overrides:
    | {
        getReviewSession?: typeof getReviewSessionForFlow;
        createWorkspacePatchExport?: typeof createWorkspacePatchExportForFlow;
        getWorkspaceOperation?: typeof getWorkspaceOperationForFlow;
        listWorkspaceArtifacts?: typeof listWorkspaceArtifactsForFlow;
        downloadWorkspaceArtifact?: typeof downloadWorkspaceArtifactForFlow;
      }
    | null
): void {
  getReviewSessionForFlow = overrides?.getReviewSession ?? getReviewSession;
  createWorkspacePatchExportForFlow = overrides?.createWorkspacePatchExport ?? createWorkspacePatchExport;
  getWorkspaceOperationForFlow = overrides?.getWorkspaceOperation ?? getWorkspaceOperation;
  listWorkspaceArtifactsForFlow = overrides?.listWorkspaceArtifacts ?? listWorkspaceArtifacts;
  downloadWorkspaceArtifactForFlow = overrides?.downloadWorkspaceArtifact ?? downloadWorkspaceArtifact;
}

function normalizeGitError(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim();
    }
    if (stderr && Buffer.isBuffer(stderr) && stderr.toString('utf8').trim()) {
      return stderr.toString('utf8').trim();
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${normalizeGitError(error)}`);
  }
}

function cleanupFailedMaterializationWorktree(repoRoot: string, branchName: string, worktreePath: string): void {
  try {
    runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    // best effort
  }
  try {
    runGit(repoRoot, ['branch', '-D', branchName]);
  } catch {
    // best effort
  }
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function validateBranchName(repoRoot: string, branchName: string): string {
  const normalized = branchName.trim();
  if (!normalized) {
    throw new Error('Branch name must not be empty.');
  }
  try {
    execFileSync('git', ['check-ref-format', '--branch', normalized], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error(`Invalid branch name "${normalized}": ${normalizeGitError(error)}`);
  }
  return normalized;
}

function defaultBranchName(sessionId: string): string {
  return `nimbus/session/${sessionId}`;
}

function resolveRepoRoot(): string {
  return new GitRepo(process.cwd()).getRepoRoot();
}

function defaultWorktreePath(repoRoot: string, session: ReviewSessionResponse): string {
  const repoLabelSeed = session.repo?.trim() || basename(repoRoot);
  const repoLabel = repoLabelSeed.replace(/[^A-Za-z0-9._-]+/g, '__').replace(/^_+|_+$/g, '') || 'repo';
  const repoHash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 10);
  return join(homedir(), '.nimbus', 'studio', 'worktrees', `${repoLabel}-${repoHash}`, session.id);
}

function resolveWorktreePath(repoRoot: string, session: ReviewSessionResponse, requestedPath?: string): string {
  if (requestedPath?.trim()) {
    return isAbsolute(requestedPath) ? requestedPath : resolve(repoRoot, requestedPath);
  }
  return defaultWorktreePath(repoRoot, session);
}

function getLatestPass(session: ReviewSessionResponse): ReviewSessionResponse['passes'][number] | null {
  return session.passes[session.passes.length - 1] ?? null;
}

function formatEnvironmentRevision(revision: ReviewEnvironmentRevision | undefined): string | null {
  if (!revision) {
    return null;
  }
  return `${revision.diffSha256.slice(0, 12)} (${revision.changedFileCount} changed files)`;
}

function isSessionPassStillActive(session: ReviewSessionResponse): boolean {
  return (
    session.currentReviewStatus === 'policy_pending' ||
    session.currentReviewStatus === 'policy_ready' ||
    session.currentReviewStatus === 'policy_approved' ||
    session.currentReviewStatus === 'queued' ||
    session.currentReviewStatus === 'running'
  );
}

function ensureSessionReadyForMaterialization(session: ReviewSessionResponse): {
  latestPass: NonNullable<ReturnType<typeof getLatestPass>>;
  environmentRevision: ReviewEnvironmentRevision;
} {
  if ((session.activeReviewId && isSessionPassStillActive(session)) || session.phase === 'reviewing' || session.phase === 'preparing') {
    throw new Error(`Review session ${session.id} still has an active pass. Wait for it to finish before bringing changes local.`);
  }
  if (!session.latestReviewId) {
    throw new Error(`Review session ${session.id} has no completed review pass to materialize.`);
  }
  if (session.currentReviewStatus !== 'succeeded') {
    throw new Error(
      `Review session ${session.id} is not in a succeeded state (${session.currentReviewStatus ?? 'unknown'}). Local materialization only supports completed successful sessions.`
    );
  }
  if (!session.anchorCommitSha) {
    throw new Error(`Review session ${session.id} has no anchor commit. Local materialization requires commit-backed provenance.`);
  }

  const latestPass = getLatestPass(session);
  if (!latestPass) {
    throw new Error(`Review session ${session.id} has no pass history to materialize.`);
  }

  if (!latestPass.environmentRevision || latestPass.environmentRevision.changedFileCount <= 0) {
    throw new Error(`Review session ${session.id} has no converged workspace changes to bring local.`);
  }

  return {
    latestPass,
    environmentRevision: latestPass.environmentRevision,
  };
}

function sessionMayStillAdvanceForMaterialization(session: ReviewSessionResponse): boolean {
  if ((session.activeReviewId && isSessionPassStillActive(session)) || session.phase === 'reviewing' || session.phase === 'preparing') {
    return true;
  }

  const latestPass = getLatestPass(session);
  return (
    session.currentReviewStatus === 'succeeded' &&
    session.passCount === 1 &&
    latestPass?.reviewBasis === 'checkpoint' &&
    !latestPass.environmentRevision
  );
}

function bestEffortValidateRepoIdentity(repoRoot: string, session: ReviewSessionResponse): void {
  try {
    const localRepoSlug = detectRepoSlugFromGitOrigin(repoRoot);
    if (localRepoSlug && session.repo && localRepoSlug !== session.repo) {
      throw new Error(
        `Current repository (${localRepoSlug}) does not match review session repo (${session.repo}). Run this command from the same repo that created the session.`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not match review session repo/.test(message)) {
      throw error;
    }
  }
}

async function waitForPatchExport(
  workerUrl: string,
  workspaceId: string,
  operationId: string,
  options?: { pollIntervalMs?: number; timeoutMs?: number }
): Promise<WorkspaceOperationResponse> {
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(pollIntervalMs, options?.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const { operation } = await getWorkspaceOperationForFlow(workerUrl, workspaceId, operationId);
    if (operation.status === 'succeeded' || operation.status === 'failed') {
      return operation;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace export ${operationId} to finish.`);
    }
    await sleep(pollIntervalMs);
  }
}

function extractArtifactId(operation: WorkspaceOperationResponse): string {
  if (!operation.result || typeof operation.result !== 'object' || Array.isArray(operation.result)) {
    throw new Error(`Workspace export ${operation.id} completed without an artifact result.`);
  }
  const artifactId = (operation.result as { artifactId?: unknown }).artifactId;
  if (typeof artifactId !== 'string' || !artifactId.trim()) {
    throw new Error(`Workspace export ${operation.id} completed without an artifact id.`);
  }
  return artifactId.trim();
}

async function resolveExportedArtifact(
  workerUrl: string,
  workspaceId: string,
  artifactId: string
): Promise<WorkspaceArtifactResponse> {
  const { artifacts } = await listWorkspaceArtifactsForFlow(workerUrl, workspaceId);
  const artifact = artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw new Error(`Exported artifact ${artifactId} is not available for workspace ${workspaceId}.`);
  }
  return artifact;
}

async function writePatchFile(patch: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'nimbus-session-patch-'));
  const patchPath = join(tempDir, 'session.patch');
  await writeFile(patchPath, patch, 'utf8');
  return patchPath;
}

async function waitForSessionMaterializationState(
  workerUrl: string,
  initialSession: ReviewSessionResponse,
  options?: { pollIntervalMs?: number; settleTimeoutMs?: number }
): Promise<{
  session: ReviewSessionResponse;
  latestPass: NonNullable<ReturnType<typeof getLatestPass>>;
  environmentRevision: ReviewEnvironmentRevision;
}> {
  let session = initialSession;
  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + Math.max(pollIntervalMs, options?.settleTimeoutMs ?? DEFAULT_SESSION_SETTLE_TIMEOUT_MS);
  let lastReadError: Error | null = null;

  while (true) {
    try {
      const resolved = ensureSessionReadyForMaterialization(session);
      return {
        session,
        ...resolved,
      };
    } catch (error) {
      if (!(error instanceof Error) || !sessionMayStillAdvanceForMaterialization(session) || Date.now() >= deadline) {
        throw error;
      }
    }

    await sleep(pollIntervalMs);
    try {
      const response = await getReviewSessionForFlow(workerUrl, session.id);
      session = response.session;
      lastReadError = null;
    } catch (error) {
      const readError = error instanceof Error ? error : new Error(String(error));
      lastReadError = readError;
      if (!sessionMayStillAdvanceForMaterialization(session) || Date.now() >= deadline) {
        throw new Error(
          `Failed to read review session ${session.id} while awaiting materialization readiness: ${lastReadError.message}`
        );
      }
    }
  }
}

export interface MaterializeReviewSessionResult {
  sessionId: string;
  branchName: string;
  worktreePath: string;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  environmentRevision: ReviewEnvironmentRevision;
}

export async function materializeReviewSessionCommand(
  sessionId: string,
  options?: {
    branchName?: string;
    path?: string;
    pollIntervalMs?: number;
  }
): Promise<MaterializeReviewSessionResult> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const initialSessionResponse = await getReviewSessionForFlow(workerUrl, sessionId);
  const {
    session,
    environmentRevision,
  } = await waitForSessionMaterializationState(workerUrl, initialSessionResponse.session, {
    pollIntervalMs: options?.pollIntervalMs,
  });
  const latestReviewId = session.latestReviewId;
  const anchorCommitSha = session.anchorCommitSha;
  if (!latestReviewId || !anchorCommitSha) {
    throw new Error(`Review session ${session.id} is missing anchor review provenance required for local materialization.`);
  }

  const repoRoot = resolveRepoRoot();
  bestEffortValidateRepoIdentity(repoRoot, session);
  runGit(repoRoot, ['cat-file', '-e', `${anchorCommitSha}^{commit}`]);

  const branchName = validateBranchName(repoRoot, options?.branchName ?? defaultBranchName(session.id));
  if (branchExists(repoRoot, branchName)) {
    throw new Error(`Branch ${branchName} already exists. Choose a different --branch name or remove the existing branch.`);
  }

  const worktreePath = resolveWorktreePath(repoRoot, session, options?.path);
  if (existsSync(worktreePath)) {
    throw new Error(`Destination path already exists: ${worktreePath}`);
  }

  const spinner = p.spinner();
  spinner.start('Exporting converged session patch...');

  const exportIdempotencyKey = `review-session-materialize:${session.id}:${session.latestReviewId}`;
  const created = await createWorkspacePatchExportForFlow(workerUrl, session.workspaceId, {
    idempotencyKey: exportIdempotencyKey,
  });
  const operation = await waitForPatchExport(workerUrl, session.workspaceId, created.operation.id, {
    pollIntervalMs: options?.pollIntervalMs,
  });
  if (operation.status !== 'succeeded') {
    const details = operation.error ? `${operation.error.code}: ${operation.error.message}` : 'unknown export failure';
    spinner.stop('Session patch export failed');
    throw new Error(`Failed to export session patch: ${details}`);
  }

  const artifactId = extractArtifactId(operation);
  const artifact = await resolveExportedArtifact(workerUrl, session.workspaceId, artifactId);
  if (artifact.type !== 'patch') {
    spinner.stop('Session patch export failed');
    throw new Error(`Expected patch artifact for review session ${session.id}, received ${artifact.type}.`);
  }
  if (artifact.sha256 !== environmentRevision.diffSha256) {
    spinner.stop('Session patch export failed');
    throw new Error(
      `Workspace diff no longer matches the latest reviewed session state (expected ${environmentRevision.diffSha256.slice(0, 12)}, got ${artifact.sha256.slice(0, 12)}). Re-run review or reset the session before bringing changes local.`
    );
  }

  const patchBytes = await downloadWorkspaceArtifactForFlow(workerUrl, session.workspaceId, artifact.id, artifact.download?.url);
  const patch = new TextDecoder().decode(patchBytes);
  if (!patch.trim()) {
    spinner.stop('Session patch export failed');
    throw new Error(`Review session ${session.id} produced an empty patch. There are no local changes to materialize.`);
  }
  spinner.stop(`Session patch ready: ${artifact.id}`);

  spinner.start('Creating isolated local review environment...');
  await mkdir(dirname(worktreePath), { recursive: true });
  runGit(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, anchorCommitSha]);
  let worktreeCreated = true;

  let patchPath: string | null = null;
  let commitSha: string | null = null;
  try {
    patchPath = await writePatchFile(patch);
    runGit(worktreePath, ['apply', '--3way', '--index', patchPath]);
    try {
      runGit(worktreePath, ['commit', '-m', `Apply Nimbus session ${session.id}`]);
      commitSha = runGit(worktreePath, ['rev-parse', 'HEAD']).trim();
    } catch (error) {
      const message = normalizeGitError(error);
      spinner.stop('Local review environment created with uncommitted changes');
      p.log.warning(`Patch applied, but commit creation failed: ${message}`);
      console.log('');
      console.log(`  Path:            ${worktreePath}`);
      console.log(`  Branch:          ${branchName}`);
      console.log(`  Anchor Commit:   ${anchorCommitSha}`);
      console.log(`  Env Revision:    ${formatEnvironmentRevision(environmentRevision)}`);
      console.log(`  Artifact ID:     ${artifact.id}`);
      return {
        sessionId: session.id,
        branchName,
        worktreePath,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        latestReviewId,
        anchorCommitSha,
        commitSha: null,
        environmentRevision,
      };
    }
  } catch (error) {
    spinner.stop('Local review environment creation failed');
    if (worktreeCreated) {
      cleanupFailedMaterializationWorktree(repoRoot, branchName, worktreePath);
      worktreeCreated = false;
    }
    throw new Error(
      `Created isolated worktree at ${worktreePath}, but failed to materialize the Nimbus patch: ${normalizeGitError(error)}`
    );
  } finally {
    if (patchPath) {
      await rm(dirname(patchPath), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  spinner.stop(`Created isolated local review environment at ${worktreePath}`);
  for (const warning of artifact.warnings) {
    if (warning && typeof warning === 'object') {
      const record = warning as { message?: unknown };
      if (typeof record.message === 'string' && record.message.trim()) {
        p.log.warning(record.message.trim());
      }
    }
  }

  console.log('');
  console.log(`  Path:            ${worktreePath}`);
  console.log(`  Branch:          ${branchName}`);
  console.log(`  Anchor Commit:   ${anchorCommitSha}`);
  console.log(`  Latest Review:   ${latestReviewId}`);
  console.log(`  Env Revision:    ${formatEnvironmentRevision(environmentRevision)}`);
  console.log(`  Artifact ID:     ${artifact.id}`);
  console.log(`  Local Commit:    ${commitSha}`);
  p.log.success(`Continue in ${worktreePath}`);

  return {
    sessionId: session.id,
    branchName,
    worktreePath,
    artifactId: artifact.id,
    artifactSha256: artifact.sha256,
    latestReviewId,
    anchorCommitSha,
    commitSha,
    environmentRevision,
  };
}
