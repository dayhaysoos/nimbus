import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { getReview, getReviewContext, getReviewSession } from '../../clients/worker/reviews.js';
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
  ReviewContextSnapshot,
  ReviewEnvironmentRevision,
  ReviewSessionResponse,
  WorkspaceArtifactResponse,
  WorkspaceOperationResponse,
} from '../../lib/types.js';
import { sleep } from './create-shared.js';
import { recordLocalReviewEnvironment } from './local-environments.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_SETTLE_TIMEOUT_MS = 120_000;
const DEFAULT_REVIEW_CONTEXT_BUCKET = 'nimbus-source-bundles';
const GIT_EAGAIN_RETRIES = 10;
const GIT_EAGAIN_SLEEP_MS = 100;

let getReviewSessionForFlow: typeof getReviewSession = getReviewSession;
let getReviewForFlow: typeof getReview = getReview;
let getReviewContextForFlow: typeof getReviewContext = getReviewContext;
let createWorkspacePatchExportForFlow: typeof createWorkspacePatchExport = createWorkspacePatchExport;
let getWorkspaceOperationForFlow: typeof getWorkspaceOperation = getWorkspaceOperation;
let listWorkspaceArtifactsForFlow: typeof listWorkspaceArtifacts = listWorkspaceArtifacts;
let downloadWorkspaceArtifactForFlow: typeof downloadWorkspaceArtifact = downloadWorkspaceArtifact;
let defaultWorktreeRootOverride: string | null = null;

export function setReviewSessionMaterializeFlowForTests(
  overrides:
    | {
        getReviewSession?: typeof getReviewSessionForFlow;
        getReview?: typeof getReviewForFlow;
        getReviewContext?: typeof getReviewContextForFlow;
        createWorkspacePatchExport?: typeof createWorkspacePatchExportForFlow;
        getWorkspaceOperation?: typeof getWorkspaceOperationForFlow;
        listWorkspaceArtifacts?: typeof listWorkspaceArtifactsForFlow;
        downloadWorkspaceArtifact?: typeof downloadWorkspaceArtifactForFlow;
        defaultWorktreeRoot?: string | null;
      }
    | null
): void {
  getReviewSessionForFlow = overrides?.getReviewSession ?? getReviewSession;
  getReviewForFlow = overrides?.getReview ?? getReview;
  getReviewContextForFlow = overrides?.getReviewContext ?? getReviewContext;
  createWorkspacePatchExportForFlow = overrides?.createWorkspacePatchExport ?? createWorkspacePatchExport;
  getWorkspaceOperationForFlow = overrides?.getWorkspaceOperation ?? getWorkspaceOperation;
  listWorkspaceArtifactsForFlow = overrides?.listWorkspaceArtifacts ?? listWorkspaceArtifacts;
  downloadWorkspaceArtifactForFlow = overrides?.downloadWorkspaceArtifact ?? downloadWorkspaceArtifact;
  if (overrides === null) {
    defaultWorktreeRootOverride = null;
  } else if (overrides && 'defaultWorktreeRoot' in overrides) {
    defaultWorktreeRootOverride = overrides.defaultWorktreeRoot ?? null;
  }
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

function isGitEagainError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const maybeError = error as { code?: string; message?: string };
    if (maybeError.code === 'EAGAIN') {
      return true;
    }
    if (typeof maybeError.message === 'string' && (maybeError.message.includes('EAGAIN') || maybeError.message.includes('Resource temporarily unavailable') || maybeError.message.includes('cannot fork()'))) {
      return true;
    }
  }
  return false;
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // best-effort short retry backoff for spawnSync git EAGAIN
  }
}

function execGitSync(
  cwd: string,
  args: string[],
  options?: { encoding?: 'utf8'; stdio?: ['ignore', 'pipe', 'pipe'] | 'ignore' }
): string {
  for (let attempt = 0; attempt < GIT_EAGAIN_RETRIES; attempt += 1) {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: options?.encoding ?? 'utf8',
        stdio: options?.stdio ?? ['ignore', 'pipe', 'pipe'],
      }) as string | Buffer | null;
      if (output == null) {
        return '';
      }
      if (typeof output === 'string') {
        return output;
      }
      return output.toString('utf8');
    } catch (error) {
      if (isGitEagainError(error) && attempt < GIT_EAGAIN_RETRIES - 1) {
        sleepSync(GIT_EAGAIN_SLEEP_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`git ${args.join(' ')} failed: exhausted retry attempts`);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execGitSync(cwd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    execGitSync(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
      encoding: 'utf8',
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
    execGitSync(repoRoot, ['check-ref-format', '--branch', normalized], {
      encoding: 'utf8',
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
  const baseRoot = defaultWorktreeRootOverride ?? join(homedir(), '.nimbus', 'studio', 'worktrees');
  return join(baseRoot, `${repoLabel}-${repoHash}`, session.id);
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

function computeWorkspaceHeadDiffSha256(worktreePath: string): string {
  const patch = runGit(worktreePath, ['diff', '--cached', '-M', 'HEAD']);
  return createHash('sha256').update(patch, 'utf8').digest('hex');
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

function isWorkspaceBaselineMissing(operation: WorkspaceOperationResponse): boolean {
  return operation.status === 'failed' && operation.error?.message === 'Workspace git baseline is missing';
}

async function applyReviewContextSnapshotToWorktree(
  worktreePath: string,
  context: ReviewContextSnapshot,
  options?: { expectedChangedFileCount?: number }
): Promise<void> {
  const changedFiles = Array.isArray(context.retrieval?.changedFiles)
    ? context.retrieval.changedFiles.filter(
        (file): file is { path: string; content: string; byteSize: number; source: 'changed' | 'related' | 'convention' } =>
          Boolean(file) &&
          typeof file.path === 'string' &&
          typeof file.content === 'string' &&
          typeof file.byteSize === 'number' &&
          file.source === 'changed'
      )
    : [];

  if (changedFiles.length === 0) {
    throw new Error('Review context snapshot did not include changed file contents.');
  }

  if (
    typeof options?.expectedChangedFileCount === 'number' &&
    Number.isFinite(options.expectedChangedFileCount) &&
    options.expectedChangedFileCount > changedFiles.length
  ) {
    throw new Error(
      `Stored review context is incomplete for safe materialization: expected ${options.expectedChangedFileCount} changed files, but only ${changedFiles.length} file snapshots are available. This likely includes deletions or renames that cannot be reconstructed safely without a git baseline.`
    );
  }

  const normalizedWorktreePrefix = `${resolve(worktreePath)}${sep}`;
  for (const file of changedFiles) {
    if (isAbsolute(file.path)) {
      throw new Error(
        `Stored review context is incomplete for safe materialization: changed path is absolute (${file.path}). Fallback reconstruction requires safe workspace-relative paths.`
      );
    }
    const resolvedPath = resolve(worktreePath, file.path);
    if (!resolvedPath.startsWith(normalizedWorktreePrefix)) {
      throw new Error(
        `Stored review context is incomplete for safe materialization: changed path escapes the workspace (${file.path}). Fallback reconstruction requires safe workspace-relative paths.`
      );
    }
  }

  const nonAnchorPaths = changedFiles
    .map((file) => file.path)
    .filter((relativePath) => !existsSync(join(worktreePath, relativePath)));
  if (nonAnchorPaths.length > 0) {
    const sample = nonAnchorPaths.slice(0, 3).join(', ');
    throw new Error(
      `Stored review context is incomplete for safe materialization: changed paths are not present at the anchor commit (${sample}). Fallback reconstruction only supports in-place file modifications; additions, deletions, and renames require a valid workspace git baseline.`
    );
  }

  for (const file of changedFiles) {
    const destinationPath = resolve(worktreePath, file.path);

    if (Buffer.byteLength(file.content, 'utf8') !== file.byteSize) {
      throw new Error(
        `Stored review context is incomplete for safe materialization: changed path appears non-text or byte-mismatched (${file.path}). Fallback reconstruction currently supports UTF-8 text files only and requires a valid workspace git baseline for binary-safe replay.`
      );
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, file.content, 'utf8');
  }

  runGit(worktreePath, ['add', '-A']);
}

function getReviewContextFallbackBucket(): string {
  const configured = process.env.NIMBUS_REVIEW_CONTEXT_BUCKET?.trim();
  return configured || DEFAULT_REVIEW_CONTEXT_BUCKET;
}

function candidateWranglerCommands(repoRoot: string): Array<{ file: string; argsPrefix: string[] }> {
  const explicit = process.env.NIMBUS_WRANGLER_BIN?.trim();
  const candidates: Array<{ file: string; argsPrefix: string[] }> = [];
  if (explicit) {
    candidates.push({ file: explicit, argsPrefix: [] });
  }

  candidates.push({ file: 'wrangler', argsPrefix: [] });
  candidates.push({ file: 'pnpm', argsPrefix: ['exec', 'wrangler'] });
  candidates.push({
    file: 'pnpm',
    argsPrefix: ['--dir', repoRoot, '--filter', '@dayhaysoos/nimbus-worker', 'exec', 'wrangler'],
  });

  const localBinCandidates = [
    resolve(process.cwd(), 'node_modules/.bin/wrangler'),
    resolve(process.cwd(), '..', 'node_modules/.bin/wrangler'),
    resolve(repoRoot, 'node_modules/.bin/wrangler'),
    resolve(repoRoot, 'packages/worker/node_modules/.bin/wrangler'),
  ];
  for (const candidate of localBinCandidates) {
    if (existsSync(candidate)) {
      candidates.push({ file: candidate, argsPrefix: [] });
    }
  }

  return candidates;
}

function fetchReviewContextViaWrangler(r2Key: string): ReviewContextSnapshot {
  const objectPath = `${getReviewContextFallbackBucket()}/${r2Key}`;
  const repoRoot = resolveRepoRoot();
  const attempts: string[] = [];
  for (const candidate of candidateWranglerCommands(repoRoot)) {
    try {
      const raw = execFileSync(
        candidate.file,
        [...candidate.argsPrefix, 'r2', 'object', 'get', objectPath, '--remote', '--pipe'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 8 * 1024 * 1024,
        }
      );
      return JSON.parse(raw) as ReviewContextSnapshot;
    } catch (error) {
      attempts.push(`${candidate.file}: ${normalizeGitError(error)}`);
    }
  }

  throw new Error(
    `Failed to fetch stored review context from R2 (${objectPath}) via Wrangler. Attempts: ${attempts.join(' | ')}`
  );
}

async function resolveReviewContextSnapshot(workerUrl: string, latestReviewId: string): Promise<ReviewContextSnapshot> {
  try {
    const reviewContext = await getReviewContextForFlow(workerUrl, latestReviewId);
    return reviewContext.context;
  } catch (routeError) {
    const routeMessage = routeError instanceof Error ? routeError.message : String(routeError);
    const review = await getReviewForFlow(workerUrl, latestReviewId);
    const r2Key = review.review.provenance.reviewContextRef?.r2Key;
    if (!r2Key) {
      throw new Error(`Stored review context is unavailable for ${latestReviewId}: ${routeMessage}`);
    }
    try {
      return fetchReviewContextViaWrangler(r2Key);
    } catch (wranglerError) {
      const wranglerMessage = wranglerError instanceof Error ? wranglerError.message : String(wranglerError);
      throw new Error(
        `Stored review context fetch failed for ${latestReviewId}. Worker route error: ${routeMessage}. Wrangler fallback error: ${wranglerMessage}`
      );
    }
  }
}

async function exportSessionArtifact(
  workerUrl: string,
  workspaceId: string,
  sessionId: string,
  latestReviewId: string,
  pollIntervalMs?: number
): Promise<{ operation: WorkspaceOperationResponse; artifact: WorkspaceArtifactResponse; kind: 'patch' }> {
  const exportIdempotencyKey = `review-session-materialize:${sessionId}:${latestReviewId}`;
  const created = await createWorkspacePatchExportForFlow(workerUrl, workspaceId, {
    idempotencyKey: exportIdempotencyKey,
  });
  const operation = await waitForPatchExport(workerUrl, workspaceId, created.operation.id, {
    pollIntervalMs,
  });
  if (operation.status === 'succeeded') {
    const artifactId = extractArtifactId(operation);
    return {
      operation,
      artifact: await resolveExportedArtifact(workerUrl, workspaceId, artifactId),
      kind: 'patch',
    };
  }

  if (isWorkspaceBaselineMissing(operation)) {
    throw new Error('Workspace git baseline is missing');
  }
  const details = operation.error ? `${operation.error.code}: ${operation.error.message}` : 'unknown export failure';
  throw new Error(`Failed to export session patch: ${details}`);
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
  mode: ReviewSessionMaterializeMode;
  branchName: string;
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  environmentRevision: ReviewEnvironmentRevision;
}

export type ReviewSessionMaterializeMode = 'worktree' | 'branch';

export async function materializeReviewSessionCommand(
  sessionId: string,
  options?: {
    branchName?: string;
    path?: string;
    mode?: ReviewSessionMaterializeMode;
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

  const mode = options?.mode ?? 'worktree';
  if (mode === 'branch' && options?.path?.trim()) {
    throw new Error('--path is only supported when materializing into a worktree.');
  }

  let worktreePath: string;
  let cleanupTempRoot: string | null = null;
  if (mode === 'branch') {
    cleanupTempRoot = await mkdtemp(join(tmpdir(), 'nimbus-session-branch-'));
    worktreePath = join(cleanupTempRoot, 'checkout');
  } else {
    worktreePath = resolveWorktreePath(repoRoot, session, options?.path);
    if (existsSync(worktreePath)) {
      throw new Error(`Destination path already exists: ${worktreePath}`);
    }
  }

  const spinner = p.spinner();
  spinner.start('Exporting converged session patch...');

  let artifactKind: 'patch' | 'context' = 'patch';
  let artifact: WorkspaceArtifactResponse;
  let reviewContextSnapshot: ReviewContextSnapshot | null = null;
  try {
    const exported = await exportSessionArtifact(
      workerUrl,
      session.workspaceId,
      session.id,
      latestReviewId,
      options?.pollIntervalMs
    );
    artifactKind = exported.kind;
    artifact = exported.artifact;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Workspace git baseline is missing')
    ) {
      reviewContextSnapshot = await resolveReviewContextSnapshot(workerUrl, latestReviewId);
      artifactKind = 'context';
      artifact = {
        id: `review_context_${session.id}`,
        workspaceId: session.workspaceId,
        type: 'patch',
        status: 'available',
        bytes: 0,
        contentType: 'application/json',
        sha256: environmentRevision.diffSha256,
        sourceBaselineSha: anchorCommitSha,
        creatorId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        warnings: [
          {
            message: 'Workspace git baseline was missing; reconstructed local adoption from stored review context.',
          },
        ],
        metadata: {},
        download: null,
      };
    } else {
      spinner.stop('Session patch export failed');
      throw error;
    }
  }

  if (artifactKind === 'patch' && artifact.type !== 'patch') {
    spinner.stop('Session patch export failed');
    throw new Error(`Expected patch artifact for review session ${session.id}, received ${artifact.type}.`);
  }
  if (artifactKind === 'patch' && artifact.sha256 !== environmentRevision.diffSha256) {
    spinner.stop('Session patch export failed');
    throw new Error(
      `Workspace diff no longer matches the latest reviewed session state (expected ${environmentRevision.diffSha256.slice(0, 12)}, got ${artifact.sha256.slice(0, 12)}). Re-run review or reset the session before bringing changes local.`
    );
  }

  const artifactBytes =
    reviewContextSnapshot === null
      ? await downloadWorkspaceArtifactForFlow(workerUrl, session.workspaceId, artifact.id, artifact.download?.url)
      : null;
  const patch = artifactKind === 'patch' && artifactBytes ? new TextDecoder().decode(artifactBytes) : null;
  if (artifactKind === 'patch' && (!patch || !patch.trim())) {
    spinner.stop('Session patch export failed');
    throw new Error(`Review session ${session.id} produced an empty patch. There are no local changes to materialize.`);
  }
  spinner.stop(
    artifactKind === 'patch'
      ? `Session patch ready: ${artifact.id}`
      : `Session snapshot ready: ${artifact.id}`
  );

  spinner.start(mode === 'branch' ? 'Creating local review branch...' : 'Creating isolated local review environment...');
  await mkdir(dirname(worktreePath), { recursive: true });
  runGit(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, anchorCommitSha]);
  let worktreeCreated = true;

  let patchPath: string | null = null;
  let commitSha: string | null = null;
  const contextMode = session.outcome?.reviewed.contextMode ?? 'unknown';
  try {
    if (artifactKind === 'patch') {
      patchPath = await writePatchFile(patch ?? '');
      runGit(worktreePath, ['apply', '--3way', '--index', patchPath]);
    } else if (reviewContextSnapshot) {
      await applyReviewContextSnapshotToWorktree(worktreePath, reviewContextSnapshot, {
        expectedChangedFileCount: environmentRevision.changedFileCount,
      });
      const materializedSha = computeWorkspaceHeadDiffSha256(worktreePath);
      if (materializedSha !== environmentRevision.diffSha256) {
        throw new Error(
          `Stored review context no longer matches the latest reviewed session state (expected ${environmentRevision.diffSha256.slice(0, 12)}, got ${materializedSha.slice(0, 12)}). Re-run review or reset the session before bringing changes local.`
        );
      }
    }
    try {
      runGit(worktreePath, ['commit', '-m', `Apply Nimbus session ${session.id}`]);
      commitSha = runGit(worktreePath, ['rev-parse', 'HEAD']).trim();
    } catch (error) {
      if (mode === 'branch') {
        throw error;
      }
      const message = normalizeGitError(error);
      spinner.stop('Local review environment created with uncommitted changes');
      p.log.warning(`Patch applied, but commit creation failed: ${message}`);
      console.log('');
      console.log(`  Path:            ${worktreePath}`);
      console.log(`  Branch:          ${branchName}`);
      console.log(`  Anchor Commit:   ${anchorCommitSha}`);
      console.log(`  Env Revision:    ${formatEnvironmentRevision(environmentRevision)}`);
      console.log(`  Artifact ID:     ${artifact.id}`);
      await recordLocalReviewEnvironment({
        sessionId: session.id,
        repoRoot,
        repo: session.repo,
        branchName,
        mode,
        worktreePath,
        artifactId: artifact.id,
        artifactSha256: artifact.sha256,
        latestReviewId,
        anchorCommitSha,
        commitSha: null,
        environmentRevision,
        contextMode,
        materializedAt: new Date().toISOString(),
      });
      return {
        sessionId: session.id,
        mode,
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
    spinner.stop(mode === 'branch' ? 'Local review branch creation failed' : 'Local review environment creation failed');
    if (worktreeCreated) {
      cleanupFailedMaterializationWorktree(repoRoot, branchName, worktreePath);
      worktreeCreated = false;
    }
    if (cleanupTempRoot) {
      await rm(cleanupTempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error(
      `Created isolated worktree at ${worktreePath}, but failed to materialize the Nimbus patch: ${normalizeGitError(error)}`
    );
  } finally {
    if (patchPath) {
      await rm(dirname(patchPath), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  let branchCleanupWarning: string | null = null;
  if (mode === 'branch') {
    try {
      runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
      worktreeCreated = false;
    } catch (error) {
      branchCleanupWarning = normalizeGitError(error);
    } finally {
      if (cleanupTempRoot) {
        await rm(cleanupTempRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  spinner.stop(
    mode === 'branch'
      ? `Created local review branch ${branchName}`
      : `Created isolated local review environment at ${worktreePath}`
  );
  for (const warning of artifact.warnings) {
    if (warning && typeof warning === 'object') {
      const record = warning as { message?: unknown };
      if (typeof record.message === 'string' && record.message.trim()) {
        p.log.warning(record.message.trim());
      }
    }
  }
  if (branchCleanupWarning) {
    p.log.warning(
      `Local worktree cleanup was incomplete (${branchCleanupWarning}). The review branch ${branchName} was created successfully; if needed, run \`git worktree prune\` and remove any stale temp worktree directories.`
    );
  }

  console.log('');
  console.log(`  Branch:          ${branchName}`);
  console.log(`  Anchor Commit:   ${anchorCommitSha}`);
  console.log(`  Latest Review:   ${latestReviewId}`);
  console.log(`  Env Revision:    ${formatEnvironmentRevision(environmentRevision)}`);
  console.log(`  Artifact ID:     ${artifact.id}`);
  console.log(`  Local Commit:    ${commitSha}`);
  await recordLocalReviewEnvironment({
    sessionId: session.id,
    repoRoot,
    repo: session.repo,
    branchName,
    mode,
    worktreePath: mode === 'worktree' ? worktreePath : null,
    artifactId: artifact.id,
    artifactSha256: artifact.sha256,
    latestReviewId,
    anchorCommitSha,
    commitSha,
    environmentRevision,
    contextMode,
    materializedAt: new Date().toISOString(),
  });
  if (mode === 'worktree') {
    console.log(`  Path:            ${worktreePath}`);
    p.log.success(`Continue in ${worktreePath}`);
  } else {
    p.log.success(`Switch with: git switch ${branchName}`);
  }

  return {
    sessionId: session.id,
    mode,
    branchName,
    worktreePath: mode === 'worktree' ? worktreePath : null,
    artifactId: artifact.id,
    artifactSha256: artifact.sha256,
    latestReviewId,
    anchorCommitSha,
    commitSha,
    environmentRevision,
  };
}
