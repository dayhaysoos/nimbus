import { once } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { getReview, getReviewSession, streamReviewEvents } from '../../clients/worker/reviews.js';
import { getWorkspaceDiff } from '../../clients/worker/workspaces.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import type {
  ReviewEventEnvelope,
  ReviewFinding,
  ReviewRunResponse,
  ReviewSessionPhase,
  ReviewSessionResponse,
  WorkspaceDiffResponse,
} from '../../lib/types.js';
import { shouldOfferReviewSessionAdoption } from './adoption.js';
import { materializeReviewSessionCommand } from './materialize.js';
import {
  buildEnterLocalReviewEnvironmentCommand,
  getLocalReviewEnvironmentDiff,
  listLocalReviewEnvironments,
  type LocalReviewEnvironmentRecord,
  mergeBackLocalReviewEnvironment,
} from './local-environments.js';
import { startStudioNewReview } from './studio-create.js';
import { getStudioNewReviewPreflightCached } from './studio-preflight-cache.js';
import { createProxyHeaders } from './ui-events-fanout.js';

const LOCAL_HOST = '127.0.0.1';
const STUDIO_CONTEXT_PATH = '/api/studio/context';
const STUDIO_NEW_REVIEW_PREFLIGHT_PATH = '/api/studio/new-review/preflight';
const STUDIO_NEW_REVIEW_START_PATH = '/api/studio/new-review/start';
const STUDIO_NEW_REVIEW_START_EVENTS_PATH = '/api/studio/new-review/start/events';
const STUDIO_LOCAL_REVIEW_SESSIONS_PATH = '/api/studio/local-review-sessions';
const STUDIO_SESSIONS_PATH_PREFIX = '/api/studio/sessions/';
const SESSION_ACTIVITY_POLL_INTERVAL_MS = 750;

let startStudioNewReviewForUiProxy: typeof startStudioNewReview = startStudioNewReview;
let getReviewSessionForUiProxy: typeof getReviewSession = getReviewSession;
let getReviewForUiProxy: typeof getReview = getReview;
let streamReviewEventsForUiProxy: typeof streamReviewEvents = streamReviewEvents;
let getWorkspaceDiffForUiProxy: typeof getWorkspaceDiff = getWorkspaceDiff;
let listLocalReviewEnvironmentsForUiProxy: typeof listLocalReviewEnvironments = listLocalReviewEnvironments;

function parseLastCheckpoints(value: unknown): 1 | 2 | 3 {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3) {
    return value as 1 | 2 | 3;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3) {
      return parsed as 1 | 2 | 3;
    }
  }
  return 1;
}

function resolveRepoRootSafe(): string | undefined {
  try {
    return new GitRepo(process.cwd()).getRepoRoot();
  } catch {
    return undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function writeSseFrame(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeJsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

type StudioSessionActivityState = 'active' | 'waiting_on_human' | 'terminal';

interface StudioSessionActivitySnapshot {
  sessionId: string;
  phase: ReviewSessionPhase;
  state: StudioSessionActivityState;
  currentReviewStatus: ReviewSessionResponse['currentReviewStatus'];
  activeReviewId: string | null;
  latestReviewId: string | null;
  passCount: number;
  summary: string;
  detail: string;
  canStream: boolean;
  streamPath: string;
  updatedAt: string;
}

interface StudioReviewedDiffPayload {
  sessionId: string;
  reviewId: string | null;
  available: boolean;
  status: 'available' | 'unavailable' | 'error';
  reason: string | null;
  path: string;
  environmentRevision: ReviewSessionResponse['passes'][number]['environmentRevision'] | null;
  diff?: WorkspaceDiffResponse;
}

interface StudioFindingRollupEntry {
  finding: ReviewFinding;
  state: 'resolved' | 'unresolved';
  firstSeenReviewId: string;
  lastSeenReviewId: string;
  reviewIds: string[];
}

interface StudioLocalEnvironmentPayload extends LocalReviewEnvironmentRecord {
  enterCommand: string;
  diffPath: string;
  mergeBackPath: string;
}

function isStudioTerminalSessionPhase(phase: ReviewSessionPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function deriveStudioSessionActivityState(session: ReviewSessionResponse): StudioSessionActivityState {
  if (session.phase === 'waiting_on_human') {
    return 'waiting_on_human';
  }
  return isStudioTerminalSessionPhase(session.phase) ? 'terminal' : 'active';
}

function buildStudioSessionPath(sessionId: string, suffix = ''): string {
  return `${STUDIO_SESSIONS_PATH_PREFIX}${encodeURIComponent(sessionId)}${suffix}`;
}

function buildStudioSessionActivitySnapshot(session: ReviewSessionResponse): StudioSessionActivitySnapshot {
  const state = deriveStudioSessionActivityState(session);
  const streamPath = buildStudioSessionPath(session.id, '/activity/events');
  const passLabel = `${session.passCount} pass${session.passCount === 1 ? '' : 'es'}`;
  const fallbackSummary = `Review session ${session.id} is ${session.phase.replace(/_/g, ' ')}.`;
  let detail = session.outcome?.summary?.trim() || fallbackSummary;

  switch (session.phase) {
    case 'preparing':
      detail = `Nimbus is preparing ${passLabel} for ${session.branch}.`;
      break;
    case 'reviewing':
      detail = `Nimbus is running ${passLabel} for ${session.branch}.`;
      break;
    case 'fixing':
      detail = 'Nimbus is applying bounded remediations to the reviewed workspace.';
      break;
    case 'verifying':
      detail = 'Nimbus is running a follow-up review pass against remediated changes.';
      break;
    case 'waiting_on_human':
      detail =
        session.currentReviewStatus === 'policy_pending' || session.currentReviewStatus === 'policy_ready'
          ? 'Waiting on policy review before analysis can continue.'
          : session.outcome?.summary?.trim() || 'Waiting on a human decision before Nimbus can continue.';
      break;
    default:
      break;
  }

  return {
    sessionId: session.id,
    phase: session.phase,
    state,
    currentReviewStatus: session.currentReviewStatus,
    activeReviewId: session.activeReviewId,
    latestReviewId: session.latestReviewId,
    passCount: session.passCount,
    summary: session.outcome?.summary?.trim() || fallbackSummary,
    detail,
    canStream: Boolean(session.activeReviewId || session.latestReviewId),
    streamPath,
    updatedAt: session.updatedAt,
  };
}

function buildFindingFingerprint(finding: ReviewFinding): string {
  return JSON.stringify({
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    description: finding.description,
    conditions: finding.conditions ?? null,
    locations: (Array.isArray(finding.locations) ? finding.locations : [])
      .map((location) => ({
        path: location.path,
        line: location.line,
      }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    suggestedFix: finding.suggestedFix
      ? {
          kind: finding.suggestedFix.kind,
          value: finding.suggestedFix.value,
        }
      : null,
  });
}

function buildStudioFindingRollup(reviews: ReviewRunResponse[], latestReviewId: string | null): {
  unresolved: ReviewFinding[];
  resolved: StudioFindingRollupEntry[];
  all: StudioFindingRollupEntry[];
} {
  const latestReview = reviews.find((review) => review.id === latestReviewId) ?? reviews[reviews.length - 1] ?? null;
  const unresolvedFingerprints = new Set((latestReview?.findings ?? []).map((finding) => buildFindingFingerprint(finding)));
  const entries = new Map<string, StudioFindingRollupEntry>();

  for (const review of reviews) {
    for (const finding of review.findings ?? []) {
      const fingerprint = buildFindingFingerprint(finding);
      const existing = entries.get(fingerprint);
      if (!existing) {
        entries.set(fingerprint, {
          finding,
          state: unresolvedFingerprints.has(fingerprint) ? 'unresolved' : 'resolved',
          firstSeenReviewId: review.id,
          lastSeenReviewId: review.id,
          reviewIds: [review.id],
        });
        continue;
      }
      existing.lastSeenReviewId = review.id;
      if (!existing.reviewIds.includes(review.id)) {
        existing.reviewIds.push(review.id);
      }
      existing.state = unresolvedFingerprints.has(fingerprint) ? 'unresolved' : existing.state;
    }
  }

  const all = [...entries.values()];
  return {
    unresolved: latestReview?.findings ?? [],
    resolved: all.filter((entry) => entry.state === 'resolved'),
    all,
  };
}

function parseIncludePatch(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return value === '1' || value === 'true' || value === 'yes';
}

function parseMaxBytes(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function resolveReviewedEnvironmentRevision(
  session: ReviewSessionResponse
): ReviewSessionResponse['passes'][number]['environmentRevision'] | null {
  return (
    session.outcome?.changes.environmentRevision ??
    session.passes
      .slice()
      .reverse()
      .find((pass) => pass.environmentRevision)?.environmentRevision ??
    null
  ) ?? null;
}

function buildStudioReviewedDiffPath(sessionId: string): string {
  return buildStudioSessionPath(sessionId, '/reviewed-diff');
}

function buildStudioLocalEnvironmentPayload(entry: LocalReviewEnvironmentRecord): StudioLocalEnvironmentPayload {
  const params = new URLSearchParams({
    mode: entry.mode,
  });
  if (entry.branchName.trim()) {
    params.set('branchName', entry.branchName);
  }
  return {
    ...entry,
    enterCommand: buildEnterLocalReviewEnvironmentCommand(entry),
    diffPath: `/api/studio/local-review-sessions/${encodeURIComponent(entry.sessionId)}/diff?${params.toString()}`,
    mergeBackPath: `/api/studio/local-review-sessions/${encodeURIComponent(entry.sessionId)}/merge-back?${params.toString()}`,
  };
}

async function loadStudioReviewedDiff(
  workerUrl: string,
  session: ReviewSessionResponse,
  options?: {
    hydrateDiff?: boolean;
    includePatch?: boolean;
    maxBytes?: number;
  }
): Promise<StudioReviewedDiffPayload> {
  const path = buildStudioReviewedDiffPath(session.id);
  const environmentRevision = resolveReviewedEnvironmentRevision(session);
  if (!session.outcome?.materializeReady || !environmentRevision || environmentRevision.changedFileCount <= 0) {
    return {
      sessionId: session.id,
      reviewId: session.latestReviewId,
      available: false,
      status: 'unavailable',
      reason: 'Session did not produce a remediated worktree diff.',
      path,
      environmentRevision,
    };
  }

  if (!options?.hydrateDiff) {
    return {
      sessionId: session.id,
      reviewId: session.latestReviewId,
      available: true,
      status: 'available',
      reason: null,
      path,
      environmentRevision,
    };
  }

  try {
    const diff = await getWorkspaceDiffForUiProxy(workerUrl, session.workspaceId, {
      includePatch: options?.includePatch,
      ...(typeof options?.maxBytes === 'number' ? { maxBytes: options.maxBytes } : {}),
    });
    const hasDiff = diff.summary.totalChanged > 0 || Boolean(diff.patch?.trim());
    return {
      sessionId: session.id,
      reviewId: session.latestReviewId,
      available: hasDiff,
      status: hasDiff ? 'available' : 'unavailable',
      reason: hasDiff ? null : 'Nimbus has no reviewed diff content to show for this session.',
      path,
      environmentRevision,
      ...(hasDiff ? { diff } : {}),
    };
  } catch (error) {
    return {
      sessionId: session.id,
      reviewId: session.latestReviewId,
      available: false,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      path,
      environmentRevision,
    };
  }
}

async function loadStudioSessionAggregate(
  workerUrl: string,
  sessionId: string,
  options?: {
    includeReviewedDiff?: boolean;
    reviewedDiffIncludePatch?: boolean;
    reviewedDiffMaxBytes?: number;
  }
): Promise<{
  session: ReviewSessionResponse;
  reviews: ReviewRunResponse[];
  latestReview: ReviewRunResponse | null;
  activeReview: ReviewRunResponse | null;
  findings: ReturnType<typeof buildStudioFindingRollup>;
  activity: StudioSessionActivitySnapshot;
  reviewedDiff: StudioReviewedDiffPayload;
  local: {
    environments: StudioLocalEnvironmentPayload[];
    hasAny: boolean;
  };
  capabilities: {
    active: boolean;
    waitingOnHuman: boolean;
    terminal: boolean;
    canShowReviewedDiff: boolean;
    canAdopt: boolean;
    canListLocalEnvironments: boolean;
    canShowLocalDiff: boolean;
    canMergeBack: boolean;
  };
  paths: {
    self: string;
    activity: string;
    activityEvents: string;
    reviewedDiff: string;
    localEnvironments: string;
    adopt: string;
  };
  adopt: {
    available: boolean;
    reason: string | null;
    path: string;
    modes: Array<'worktree' | 'branch'>;
  };
}> {
  const { session } = await getReviewSessionForUiProxy(workerUrl, sessionId);
  const reviews = await Promise.all(session.passes.map(async (pass) => (await getReviewForUiProxy(workerUrl, pass.reviewId)).review));
  const latestReview = reviews.find((review) => review.id === session.latestReviewId) ?? reviews[reviews.length - 1] ?? null;
  const activeReview = session.activeReviewId
    ? reviews.find((review) => review.id === session.activeReviewId) ?? null
    : null;
  const findings = buildStudioFindingRollup(reviews, session.latestReviewId);
  const activity = buildStudioSessionActivitySnapshot(session);
  const reviewedDiff = await loadStudioReviewedDiff(workerUrl, session, {
    hydrateDiff: options?.includeReviewedDiff === true,
    includePatch: options?.includeReviewedDiff ? options.reviewedDiffIncludePatch : false,
    maxBytes: options?.reviewedDiffMaxBytes,
  });
  const repoRoot = resolveRepoRootSafe();
  const environments = repoRoot
    ? (await listLocalReviewEnvironmentsForUiProxy({ repoRoot }))
        .filter((entry) => entry.sessionId === session.id)
        .map((entry) => buildStudioLocalEnvironmentPayload(entry))
    : [];
  const active = activity.state === 'active';
  const waitingOnHuman = activity.state === 'waiting_on_human';
  const terminal = activity.state === 'terminal';
  const canAdopt = shouldOfferReviewSessionAdoption(session);
  const paths = {
    self: buildStudioSessionPath(session.id),
    activity: buildStudioSessionPath(session.id, '/activity'),
    activityEvents: buildStudioSessionPath(session.id, '/activity/events'),
    reviewedDiff: reviewedDiff.path,
    localEnvironments: `${STUDIO_LOCAL_REVIEW_SESSIONS_PATH}?sessionId=${encodeURIComponent(session.id)}`,
    adopt: `/api/studio/local-review-sessions/${encodeURIComponent(session.id)}/adopt`,
  };

  return {
    session,
    reviews,
    latestReview,
    activeReview,
    findings,
    activity,
    reviewedDiff,
    local: {
      environments,
      hasAny: environments.length > 0,
    },
    capabilities: {
      active,
      waitingOnHuman,
      terminal,
      canShowReviewedDiff: reviewedDiff.available,
      canAdopt,
      canListLocalEnvironments: Boolean(repoRoot),
      canShowLocalDiff: environments.length > 0,
      canMergeBack: environments.length > 0,
    },
    paths,
    adopt: {
      available: canAdopt,
      reason: canAdopt
        ? null
        : repoRoot
          ? 'Nimbus can only adopt reviewed changes once a session reaches an adoptable outcome.'
          : 'Open Review Studio from inside a git repository to adopt reviewed changes.',
      path: paths.adopt,
      modes: ['worktree', 'branch'],
    },
  };
}

function humanizeReviewEventType(value: string): string {
  return value
    .replace(/^review_/, '')
    .replace(/^task_/, '')
    .replace(/^deployment_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildStudioActivityDetail(
  rawType: string,
  payload: Record<string, unknown>,
  reviewId: string
): { kind: 'policy' | 'progress' | 'finding' | 'remediation' | 'terminal' | 'status'; label: string; detail: string } {
  switch (rawType) {
    case 'snapshot':
      return {
        kind: 'status',
        label: 'Review snapshot',
        detail: `Review ${reviewId} is ${typeof payload.status === 'string' ? payload.status : 'active'}.`,
      };
    case 'terminal':
      return {
        kind: 'terminal',
        label: 'Review terminal state',
        detail: `Review ${reviewId} ended ${typeof payload.status === 'string' ? payload.status : 'without a final status'}.`,
      };
    case 'review_finding_emitted':
      return {
        kind: 'finding',
        label: 'Finding emitted',
        detail: `${payload.severity ?? 'unknown'} ${payload.category ?? 'finding'}: ${payload.description ?? 'No description provided.'}`,
      };
    case 'review_auto_remediation_planned':
      return {
        kind: 'remediation',
        label: 'Remediation planned',
        detail: 'Nimbus found a safe remediation path and is preparing to apply it.',
      };
    case 'review_auto_remediation_started':
      return {
        kind: 'remediation',
        label: 'Remediation started',
        detail: `Nimbus started the remediation task${typeof payload.taskId === 'string' ? ` ${payload.taskId}` : ''}.`,
      };
    case 'review_auto_remediation_completed':
      return {
        kind: 'remediation',
        label: 'Remediation completed',
        detail:
          typeof payload.nextReviewId === 'string'
            ? `Nimbus completed remediation and queued follow-up review ${payload.nextReviewId}.`
            : 'Nimbus completed remediation and is preparing the next pass.',
      };
    case 'review_auto_remediation_failed':
      return {
        kind: 'remediation',
        label: 'Remediation failed',
        detail:
          payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
            ? `Remediation failed: ${String((payload.error as { message?: unknown }).message ?? 'unknown error')}.`
            : 'Nimbus could not complete the remediation task.',
      };
    case 'review_policy_derivation_started':
    case 'review_policy_derivation_completed':
    case 'review_policy_approved':
      return {
        kind: 'policy',
        label: humanizeReviewEventType(rawType),
        detail: humanizeReviewEventType(rawType),
      };
    case 'review_succeeded':
    case 'review_failed':
    case 'review_cancelled':
      return {
        kind: 'terminal',
        label: humanizeReviewEventType(rawType),
        detail:
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim()
            : humanizeReviewEventType(rawType),
      };
    default:
      if (rawType.startsWith('review_analysis_') || rawType.startsWith('review_context_')) {
        return {
          kind: 'progress',
          label: humanizeReviewEventType(rawType),
          detail:
            typeof payload.tool === 'string'
              ? `Tool: ${payload.tool}`
              : typeof payload.message === 'string' && payload.message.trim()
                ? payload.message.trim()
                : humanizeReviewEventType(rawType),
        };
      }
      return {
        kind: rawType.includes('policy') ? 'policy' : 'status',
        label: humanizeReviewEventType(rawType),
        detail:
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim()
            : humanizeReviewEventType(rawType),
      };
  }
}

function normalizeReviewEventForStudioActivity(input: {
  sessionId: string;
  reviewId: string;
  passIndex: number;
  event: ReviewEventEnvelope;
}):
  | {
      type: 'activity';
      sessionId: string;
      reviewId: string;
      passIndex: number;
      rawType: string;
      kind: 'policy' | 'progress' | 'finding' | 'remediation' | 'terminal' | 'status';
      label: string;
      detail: string;
      createdAt: string | null;
      seq: number | null;
      payload: Record<string, unknown>;
    }
  | null {
  const payload = input.event.data;
  const rawType = typeof payload.type === 'string' ? payload.type : 'unknown';
  if (rawType === 'heartbeat') {
    return null;
  }
  const details = buildStudioActivityDetail(rawType, payload, input.reviewId);
  return {
    type: 'activity',
    sessionId: input.sessionId,
    reviewId: input.reviewId,
    passIndex: input.passIndex,
    rawType,
    kind: details.kind,
    label: details.label,
    detail: details.detail,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    seq: typeof payload.seq === 'number' && Number.isFinite(payload.seq) ? payload.seq : null,
    payload,
  };
}

async function streamStudioSessionActivity(options: {
  sessionId: string;
  workerUrl: string;
  response: ServerResponse;
  signal: AbortSignal;
}): Promise<void> {
  let snapshotKey = '';
  const seenReviewIds = new Set<string>();

  // Re-fetch session state between passes so one stream can cover the full lifecycle.
  while (!options.signal.aborted) {
    const session = (await getReviewSessionForUiProxy(options.workerUrl, options.sessionId)).session;
    const snapshot = buildStudioSessionActivitySnapshot(session);
    const nextSnapshotKey = JSON.stringify({
      phase: snapshot.phase,
      state: snapshot.state,
      currentReviewStatus: snapshot.currentReviewStatus,
      activeReviewId: snapshot.activeReviewId,
      latestReviewId: snapshot.latestReviewId,
      updatedAt: snapshot.updatedAt,
    });
    if (nextSnapshotKey !== snapshotKey) {
      snapshotKey = nextSnapshotKey;
      writeSseFrame(options.response, {
        type: 'snapshot',
        sessionId: session.id,
        activity: snapshot,
      });
    }

    const reviewIds = session.passes.map((pass) => pass.reviewId).filter((reviewId) => !seenReviewIds.has(reviewId));
    if (reviewIds.length === 0) {
      if (isStudioTerminalSessionPhase(session.phase) || (session.phase === 'waiting_on_human' && !session.activeReviewId)) {
        writeSseFrame(options.response, {
          type: 'terminal',
          sessionId: session.id,
          activity: buildStudioSessionActivitySnapshot(session),
        });
        return;
      }
      await sleep(SESSION_ACTIVITY_POLL_INTERVAL_MS);
      continue;
    }

    for (const reviewId of reviewIds) {
      seenReviewIds.add(reviewId);
      const passIndex = session.passes.findIndex((pass) => pass.reviewId === reviewId);
      await streamReviewEventsForUiProxy(
        options.workerUrl,
        reviewId,
        async (event) => {
          const normalized = normalizeReviewEventForStudioActivity({
            sessionId: session.id,
            reviewId,
            passIndex,
            event,
          });
          if (!normalized || options.signal.aborted) {
            return;
          }
          writeSseFrame(options.response, normalized);
        },
        { signal: options.signal }
      );
      if (options.signal.aborted) {
        return;
      }
    }
  }
}

export function setUiProxyHooksForTests(
  overrides: {
    startStudioNewReview?: typeof startStudioNewReview;
    getReviewSession?: typeof getReviewSession;
    getReview?: typeof getReview;
    streamReviewEvents?: typeof streamReviewEvents;
    getWorkspaceDiff?: typeof getWorkspaceDiff;
    listLocalReviewEnvironments?: typeof listLocalReviewEnvironments;
  } | null
): void {
  startStudioNewReviewForUiProxy = overrides?.startStudioNewReview ?? startStudioNewReview;
  getReviewSessionForUiProxy = overrides?.getReviewSession ?? getReviewSession;
  getReviewForUiProxy = overrides?.getReview ?? getReview;
  streamReviewEventsForUiProxy = overrides?.streamReviewEvents ?? streamReviewEvents;
  getWorkspaceDiffForUiProxy = overrides?.getWorkspaceDiff ?? getWorkspaceDiff;
  listLocalReviewEnvironmentsForUiProxy = overrides?.listLocalReviewEnvironments ?? listLocalReviewEnvironments;
}

export async function proxyApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workerUrl: string,
  apiKey: string | null,
  reviewGithubToken: string | null,
  providerApiKey: string | null,
  openrouterApiKey: string | null
): Promise<boolean> {
  const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_HOST}`);
  if (requestUrl.pathname === STUDIO_CONTEXT_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    let repo: string | null = null;
    let branch: string | null = null;
    try {
      repo = detectRepoSlugFromGitOrigin();
    } catch {
      repo = null;
    }
    try {
      branch = new GitRepo(process.cwd()).getCurrentBranchRef();
    } catch {
      branch = null;
    }

    const payload = {
      repo,
      branch,
      detectedAt: new Date().toISOString(),
    };
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (method === 'HEAD') {
      response.end();
      return true;
    }
    response.end(JSON.stringify(payload));
    return true;
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_PREFLIGHT_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    try {
      const payload = await getStudioNewReviewPreflightCached({
        repoRoot: resolveRepoRootSafe(),
        lastCheckpoints: parseLastCheckpoints(requestUrl.searchParams.get('lastCheckpoints')),
      });
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (method === 'HEAD') {
        response.end();
        return true;
      }
      response.end(JSON.stringify(payload));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: `Failed to load Studio preflight: ${message}` }));
      return true;
    }
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_START_PATH) {
    const method = (request.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }
    try {
      const body = await readBody(request);
      const payload = JSON.parse(body.toString('utf8')) as {
        policyMode?: unknown;
        repo?: unknown;
        branch?: unknown;
        lastCheckpoints?: unknown;
      };
      const policyMode = payload?.policyMode;
      if (policyMode !== 'auto' && policyMode !== 'review') {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Invalid policyMode. Use auto or review.' }));
        return true;
      }

      const expectedRepo = typeof payload.repo === 'string' ? payload.repo : null;
      const expectedBranch = typeof payload.branch === 'string' ? payload.branch : null;
      const started = await startStudioNewReviewForUiProxy({
        policyMode,
        lastCheckpoints: parseLastCheckpoints(payload.lastCheckpoints),
        repoRoot: resolveRepoRootSafe(),
        expectedRepo,
        expectedBranch,
      });
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(started));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: `Failed to start review: ${message}` }));
      return true;
    }
  }

  if (requestUrl.pathname === STUDIO_NEW_REVIEW_START_EVENTS_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const policyMode = requestUrl.searchParams.get('policyMode');
    if (policyMode !== 'auto' && policyMode !== 'review') {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: 'Invalid policyMode. Use auto or review.' }));
      return true;
    }

    const expectedRepo = requestUrl.searchParams.get('repo');
    const expectedBranch = requestUrl.searchParams.get('branch');
    const lastCheckpoints = parseLastCheckpoints(requestUrl.searchParams.get('lastCheckpoints'));
    let streamOpen = true;
    const abortController = new AbortController();
    response.on('close', () => {
      streamOpen = false;
      abortController.abort();
    });
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.flushHeaders?.();

    try {
      await startStudioNewReviewForUiProxy({
        policyMode,
        lastCheckpoints,
        repoRoot: resolveRepoRootSafe(),
        expectedRepo,
        expectedBranch,
        signal: abortController.signal,
        onEvent: async (event) => {
          if (!streamOpen || abortController.signal.aborted) {
            return;
          }
          try {
            writeSseFrame(response, event);
          } catch {
            streamOpen = false;
            abortController.abort();
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamOpen) {
        writeSseFrame(response, {
          type: 'error',
          message: `Failed to start review: ${message}`,
        });
      }
    } finally {
      if (streamOpen) {
        response.end();
      }
    }
    return true;
  }

  if (requestUrl.pathname.startsWith(STUDIO_SESSIONS_PATH_PREFIX)) {
    const sessionSuffix = requestUrl.pathname.slice(STUDIO_SESSIONS_PATH_PREFIX.length);
    const [rawSessionId, ...restSegments] = sessionSuffix.split('/');
    const sessionId = rawSessionId?.trim();
    const subpath = restSegments.length > 0 ? `/${restSegments.join('/')}` : '';
    if (sessionId) {
      if (subpath === '' || subpath === '/') {
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          writeJsonResponse(response, 405, { error: 'Method not allowed' });
          return true;
        }
        try {
          const payload = await loadStudioSessionAggregate(workerUrl, sessionId, {
            includeReviewedDiff: parseIncludePatch(requestUrl.searchParams.get('includeReviewedDiff')),
            reviewedDiffIncludePatch: parseIncludePatch(requestUrl.searchParams.get('includePatch')),
            reviewedDiffMaxBytes: parseMaxBytes(requestUrl.searchParams.get('maxBytes')),
          });
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (method === 'HEAD') {
            response.end();
            return true;
          }
          response.end(JSON.stringify(payload));
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJsonResponse(response, /not found/i.test(message) ? 404 : 500, {
            error: `Failed to load Studio session ${sessionId}: ${message}`,
          });
          return true;
        }
      }

      if (subpath === '/reviewed-diff') {
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          writeJsonResponse(response, 405, { error: 'Method not allowed' });
          return true;
        }
        try {
          const { session } = await getReviewSessionForUiProxy(workerUrl, sessionId);
          const payload = await loadStudioReviewedDiff(workerUrl, session, {
            hydrateDiff: true,
            includePatch: parseIncludePatch(requestUrl.searchParams.get('includePatch')),
            maxBytes: parseMaxBytes(requestUrl.searchParams.get('maxBytes')),
          });
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (method === 'HEAD') {
            response.end();
            return true;
          }
          response.end(JSON.stringify(payload));
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJsonResponse(response, /not found/i.test(message) ? 404 : 500, {
            error: `Failed to load reviewed diff for session ${sessionId}: ${message}`,
          });
          return true;
        }
      }

      if (subpath === '/activity') {
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          writeJsonResponse(response, 405, { error: 'Method not allowed' });
          return true;
        }
        try {
          const { session } = await getReviewSessionForUiProxy(workerUrl, sessionId);
          const payload = {
            sessionId,
            activity: buildStudioSessionActivitySnapshot(session),
          };
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (method === 'HEAD') {
            response.end();
            return true;
          }
          response.end(JSON.stringify(payload));
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          writeJsonResponse(response, /not found/i.test(message) ? 404 : 500, {
            error: `Failed to load session activity for ${sessionId}: ${message}`,
          });
          return true;
        }
      }

      if (subpath === '/activity/events') {
        const method = (request.method ?? 'GET').toUpperCase();
        if (method !== 'GET') {
          writeJsonResponse(response, 405, { error: 'Method not allowed' });
          return true;
        }
        let streamOpen = true;
        const abortController = new AbortController();
        response.on('close', () => {
          streamOpen = false;
          abortController.abort();
        });
        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Connection', 'keep-alive');
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.flushHeaders?.();

        try {
          await streamStudioSessionActivity({
            sessionId,
            workerUrl,
            response,
            signal: abortController.signal,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (streamOpen) {
            writeSseFrame(response, {
              type: 'error',
              sessionId,
              message: `Failed to stream session activity: ${message}`,
            });
          }
        } finally {
          if (streamOpen) {
            response.end();
          }
        }
        return true;
      }
    }
  }

  if (requestUrl.pathname === STUDIO_LOCAL_REVIEW_SESSIONS_PATH) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      writeJsonResponse(response, 405, { error: 'Method not allowed' });
      return true;
    }

    const repoRoot = resolveRepoRootSafe();
    if (!repoRoot) {
      writeJsonResponse(response, 200, { environments: [] });
      return true;
    }

    try {
      const sessionId = requestUrl.searchParams.get('sessionId')?.trim() || null;
      const entries = await listLocalReviewEnvironmentsForUiProxy({ repoRoot });
      const environments = entries
        .filter((entry) => !sessionId || entry.sessionId === sessionId)
        .map((entry) => ({
          ...entry,
          enterCommand: buildEnterLocalReviewEnvironmentCommand(entry),
        }));
      writeJsonResponse(response, 200, { environments });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, { error: `Failed to load local review environments: ${message}` });
      return true;
    }
  }

  const localReviewSessionAdoptMatch = requestUrl.pathname.match(
    /^\/api\/studio\/local-review-sessions\/([a-z0-9_]+)\/adopt$/
  );
  if (localReviewSessionAdoptMatch) {
    const method = (request.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      writeJsonResponse(response, 405, { error: 'Method not allowed' });
      return true;
    }

    const repoRoot = resolveRepoRootSafe();
    if (!repoRoot) {
      writeJsonResponse(response, 400, { error: 'Open Review Studio from inside a git repository to adopt a session.' });
      return true;
    }

    try {
      const body = await readBody(request);
      const payload = body.length > 0 ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
      const mode = payload.mode === 'branch' ? 'branch' : 'worktree';
      const result = await materializeReviewSessionCommand(localReviewSessionAdoptMatch[1], {
        mode,
        branchName: typeof payload.branchName === 'string' ? payload.branchName : undefined,
        path: typeof payload.path === 'string' ? payload.path : undefined,
      });
      writeJsonResponse(response, 200, {
        ...result,
        enterCommand: result.worktreePath
          ? `cd -- '${result.worktreePath.replace(/'/g, `'\"'\"'`)}'`
          : `git switch -- '${result.branchName.replace(/'/g, `'\"'\"'`)}'`,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, { error: `Failed to adopt review session: ${message}` });
      return true;
    }
  }

  const localReviewSessionDiffMatch = requestUrl.pathname.match(
    /^\/api\/studio\/local-review-sessions\/([a-z0-9_]+)\/diff$/
  );
  if (localReviewSessionDiffMatch) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      writeJsonResponse(response, 405, { error: 'Method not allowed' });
      return true;
    }

    const repoRoot = resolveRepoRootSafe();
    if (!repoRoot) {
      writeJsonResponse(response, 400, { error: 'Open Review Studio from inside a git repository to diff an adopted session.' });
      return true;
    }

    try {
      const result = await getLocalReviewEnvironmentDiff(localReviewSessionDiffMatch[1], {
        baseRef: requestUrl.searchParams.get('baseRef') ?? undefined,
        repoRoot,
        branchName: requestUrl.searchParams.get('branchName') ?? undefined,
        mode:
          requestUrl.searchParams.get('mode') === 'branch' || requestUrl.searchParams.get('mode') === 'worktree'
            ? (requestUrl.searchParams.get('mode') as 'branch' | 'worktree')
            : undefined,
      });
      writeJsonResponse(response, 200, {
        ...result,
        enterCommand: buildEnterLocalReviewEnvironmentCommand(result.entry),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, { error: `Failed to diff local review environment: ${message}` });
      return true;
    }
  }

  const localReviewSessionMergeBackMatch = requestUrl.pathname.match(
    /^\/api\/studio\/local-review-sessions\/([a-z0-9_]+)\/merge-back$/
  );
  if (localReviewSessionMergeBackMatch) {
    const method = (request.method ?? 'POST').toUpperCase();
    if (method !== 'POST') {
      writeJsonResponse(response, 405, { error: 'Method not allowed' });
      return true;
    }

    const repoRoot = resolveRepoRootSafe();
    if (!repoRoot) {
      writeJsonResponse(response, 400, { error: 'Open Review Studio from inside a git repository to merge back an adopted session.' });
      return true;
    }

    try {
      const result = await mergeBackLocalReviewEnvironment(localReviewSessionMergeBackMatch[1], {
        repoRoot,
        branchName: requestUrl.searchParams.get('branchName') ?? undefined,
        mode:
          requestUrl.searchParams.get('mode') === 'branch' || requestUrl.searchParams.get('mode') === 'worktree'
            ? (requestUrl.searchParams.get('mode') as 'branch' | 'worktree')
            : undefined,
      });
      writeJsonResponse(response, 200, result);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, { error: `Failed to merge back local review environment: ${message}` });
      return true;
    }
  }

  if (!(requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/'))) {
    return false;
  }

  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, workerUrl);
  const method = (request.method ?? 'GET').toUpperCase();
  const headers = createProxyHeaders(request.headers, {
    apiKey,
    reviewGithubToken,
    providerApiKey,
    openrouterApiKey,
  });

  const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await readBody(request));
  const upstream = await fetch(targetUrl.toString(), {
    method,
    headers,
    body,
  });

  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') {
      return;
    }
    response.setHeader(key, value);
  });

  if (!upstream.body || method === 'HEAD') {
    response.end();
    return true;
  }

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    if (!response.write(Buffer.from(value))) {
      await once(response, 'drain');
    }
  }
  response.end();
  return true;
}
