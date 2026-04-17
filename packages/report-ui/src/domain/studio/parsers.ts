import type {
  LocalReviewEnvironment,
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentListResponse,
  LocalReviewEnvironmentMergeBackResponse,
  StudioAdoptResponse,
  StudioContextResponse,
  StudioLocalReviewEnvironment,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartResponse,
  StudioNewReviewStartStreamEvent,
  StudioReviewedDiffResponse,
  StudioSessionActivityEvent,
  StudioSessionActivitySnapshot,
  StudioSessionActivitySnapshotResponse,
  StudioSessionAggregateResponse,
  StudioSessionFindingRollupEntry,
  WorkspaceDiffResponse,
} from './contracts';
import {
  asRecord,
  parseGetReviewResponse,
  parseReviewSessionResponse,
  readContextMode,
  readEnvironmentRevision,
  readFindings,
  readNullableTimestamp,
  readOptionalString,
  readRecommendation,
  readReviewBasis,
  readSessionPhase,
  readSeverity,
  readStatus,
  readString,
  readStringList,
} from '../review/parsers';

function parseWorkspaceDiffResponse(value: unknown): WorkspaceDiffResponse {
  const root = asRecord(value);
  return {
    workspaceId: readString(root.workspaceId, 'workspaceId'),
    includePatch: root.includePatch === true,
    maxBytes: Number(root.maxBytes) || 0,
    truncated: root.truncated === true,
    changedFilesTruncated: root.changedFilesTruncated === undefined ? undefined : root.changedFilesTruncated === true,
    patchTruncated: root.patchTruncated === undefined ? undefined : root.patchTruncated === true,
    summaryIsPartial: root.summaryIsPartial === undefined ? undefined : root.summaryIsPartial === true,
    summary: {
      added: Number(asRecord(root.summary).added) || 0,
      modified: Number(asRecord(root.summary).modified) || 0,
      deleted: Number(asRecord(root.summary).deleted) || 0,
      renamed: Number(asRecord(root.summary).renamed) || 0,
      totalChanged: Number(asRecord(root.summary).totalChanged) || 0,
    },
    changedFiles: Array.isArray(root.changedFiles)
      ? root.changedFiles.map((item, index) => {
          const file = asRecord(item);
          return {
            path: readString(file.path, `changedFiles[${index}].path`),
            status:
              file.status === 'added' ||
              file.status === 'modified' ||
              file.status === 'deleted' ||
              file.status === 'renamed'
                ? file.status
                : 'modified',
            ...(readOptionalString(file.previousPath) ? { previousPath: readOptionalString(file.previousPath) ?? undefined } : {}),
          };
        })
      : [],
    changedFilesBytes: root.changedFilesBytes === undefined ? undefined : Number(root.changedFilesBytes) || 0,
    changedFilesTotalBytes: root.changedFilesTotalBytes === undefined ? undefined : Number(root.changedFilesTotalBytes) || 0,
    patch: typeof root.patch === 'string' ? root.patch : undefined,
    patchBytes: root.patchBytes === undefined ? undefined : Number(root.patchBytes) || 0,
    patchTotalBytes: root.patchTotalBytes === undefined ? undefined : Number(root.patchTotalBytes) || 0,
  };
}

function parseLocalReviewEnvironment(value: unknown): LocalReviewEnvironment {
  const root = asRecord(value);
  const environmentRevision = readEnvironmentRevision(root.environmentRevision);
  if (!environmentRevision) {
    throw new Error('Invalid local review environment payload: environmentRevision is required.');
  }
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    repoRoot: readString(root.repoRoot, 'repoRoot'),
    repo: readOptionalString(root.repo),
    branchName: readString(root.branchName, 'branchName'),
    mode: root.mode === 'branch' ? 'branch' : 'worktree',
    worktreePath: readOptionalString(root.worktreePath),
    artifactId: readString(root.artifactId, 'artifactId'),
    artifactSha256: readString(root.artifactSha256, 'artifactSha256'),
    latestReviewId: readString(root.latestReviewId, 'latestReviewId'),
    anchorCommitSha: readString(root.anchorCommitSha, 'anchorCommitSha'),
    commitSha: readOptionalString(root.commitSha),
    environmentRevision,
    contextMode: root.contextMode === 'unknown' ? 'unknown' : readContextMode(root.contextMode),
    materializedAt: readString(root.materializedAt, 'materializedAt'),
    enterCommand: readString(root.enterCommand, 'enterCommand'),
  };
}

export function parseLocalReviewEnvironmentListResponse(payload: unknown): LocalReviewEnvironmentListResponse {
  const root = asRecord(payload);
  if (!Array.isArray(root.environments)) {
    throw new Error('Invalid local review environment payload: environments must be an array.');
  }
  return {
    environments: root.environments.map((item) => parseLocalReviewEnvironment(item)),
  };
}

export function parseLocalReviewEnvironmentDiffResponse(payload: unknown): LocalReviewEnvironmentDiffResponse {
  const root = asRecord(payload);
  return {
    entry: parseLocalReviewEnvironment(root.entry),
    baseRef: readString(root.baseRef, 'baseRef'),
    diff: typeof root.diff === 'string' ? root.diff : '',
    hasDiff: root.hasDiff === true,
    enterCommand: readString(root.enterCommand, 'enterCommand'),
  };
}

export function parseLocalReviewEnvironmentMergeBackResponse(
  payload: unknown
): LocalReviewEnvironmentMergeBackResponse {
  const root = asRecord(payload);
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    currentBranch: readString(root.currentBranch, 'currentBranch'),
    sourceBranch: readString(root.sourceBranch, 'sourceBranch'),
    sourceCommit: readString(root.sourceCommit, 'sourceCommit'),
    newHead: readOptionalString(root.newHead),
    worktreePath: readOptionalString(root.worktreePath),
    status: root.status === 'already_applied' ? 'already_applied' : 'applied',
  };
}

export function parseStudioAdoptResponse(payload: unknown): StudioAdoptResponse {
  const root = asRecord(payload);
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    mode: root.mode === 'branch' ? 'branch' : 'worktree',
    branchName: readString(root.branchName, 'branchName'),
    worktreePath: readOptionalString(root.worktreePath),
    artifactId: readString(root.artifactId, 'artifactId'),
    artifactSha256: readString(root.artifactSha256, 'artifactSha256'),
    latestReviewId: readString(root.latestReviewId, 'latestReviewId'),
    anchorCommitSha: readString(root.anchorCommitSha, 'anchorCommitSha'),
    commitSha: readOptionalString(root.commitSha),
    enterCommand: readString(root.enterCommand, 'enterCommand'),
  };
}

export function parseStudioContextResponse(payload: unknown): StudioContextResponse {
  const root = asRecord(payload);
  return {
    repo: readOptionalString(root.repo),
    branch: readOptionalString(root.branch),
    detectedAt: readString(root.detectedAt, 'detectedAt'),
  };
}

export function parseStudioNewReviewPreflightResponse(payload: unknown): StudioNewReviewPreflightResponse {
  const root = asRecord(payload);
  const capabilities = asRecord(root.capabilities);
  const readIssue = (
    value: unknown,
    label: string
  ): { code: StudioNewReviewPreflightResponse['blockingIssues'][number]['code']; message: string } => {
    const issue = asRecord(value);
    const code =
      issue.code === 'checkpoint_unavailable' ||
      issue.code === 'checkpoint_missing_trailer' ||
      issue.code === 'entire_context_unavailable' ||
      issue.code === 'branch_context_changed' ||
      issue.code === 'unknown'
        ? issue.code
        : 'unknown';
    return {
      code,
      message: readString(issue.message, `${label}.message`),
    };
  };

  return {
    repo: readOptionalString(root.repo),
    branch: readOptionalString(root.branch),
    policyMode: root.policyMode === 'review' ? 'review' : 'auto',
    startability:
      root.startability === 'blocked' || root.startability === 'basic' || root.startability === 'intent_aware'
        ? root.startability
        : 'blocked',
    contextMode: readContextMode(root.contextMode),
    requestedLastCheckpoints:
      root.requestedLastCheckpoints === 2 || root.requestedLastCheckpoints === 3 ? root.requestedLastCheckpoints : 1,
    effectiveLastCheckpoints:
      root.effectiveLastCheckpoints === 2 || root.effectiveLastCheckpoints === 3 ? root.effectiveLastCheckpoints : 1,
    lastCheckpoints: root.lastCheckpoints === 2 || root.lastCheckpoints === 3 ? root.lastCheckpoints : 1,
    checkpointSelectionMode: root.checkpointSelectionMode === 'last_n' ? 'last_n' : 'latest',
    checkpointId: readOptionalString(root.checkpointId),
    commitSha: readOptionalString(root.commitSha),
    includedCheckpoints: Array.isArray(root.includedCheckpoints)
      ? root.includedCheckpoints.map((item, index) => {
          const checkpoint = asRecord(item);
          return {
            checkpointId: readString(checkpoint.checkpointId, `includedCheckpoints[${index}].checkpointId`),
            commitSha: readString(checkpoint.commitSha, `includedCheckpoints[${index}].commitSha`),
            commitSubject: readString(checkpoint.commitSubject, `includedCheckpoints[${index}].commitSubject`),
          };
        })
      : [],
    ready: root.ready === true,
    capabilities: {
      canStart: capabilities.canStart === true,
      canStartInBasicMode: capabilities.canStartInBasicMode === true,
      canStartInIntentAwareMode: capabilities.canStartInIntentAwareMode === true,
      canReviewPolicy: capabilities.canReviewPolicy === true,
    },
    blockingIssues: Array.isArray(root.blockingIssues)
      ? root.blockingIssues.map((item, index) => readIssue(item, `blockingIssues[${index}]`))
      : [],
    warnings: Array.isArray(root.warnings)
      ? root.warnings.map((item, index) => readIssue(item, `warnings[${index}]`))
      : [],
    checks: Array.isArray(root.checks)
      ? root.checks.map((item, index) => {
          const check = asRecord(item);
          return {
            code: check.code === 'entire_context' ? 'entire_context' : 'checkpoint',
            label: readString(check.label, `checks[${index}].label`),
            ok: check.ok === true,
            detail: readString(check.detail, `checks[${index}].detail`),
          };
        })
      : [],
    error:
      root.error && typeof root.error === 'object' && !Array.isArray(root.error)
        ? readIssue(root.error, 'error')
        : undefined,
  };
}

export function parseStudioNewReviewStartResponse(payload: unknown): StudioNewReviewStartResponse {
  const root = asRecord(payload);
  return {
    reviewId: readString(root.reviewId, 'reviewId'),
    sessionId: readOptionalString(root.sessionId),
    routePath: readString(root.routePath, 'routePath'),
    policyMode: root.policyMode === 'review' ? 'review' : 'auto',
    contextMode: readContextMode(root.contextMode),
    requestedLastCheckpoints:
      root.requestedLastCheckpoints === 2 || root.requestedLastCheckpoints === 3 ? root.requestedLastCheckpoints : 1,
    effectiveLastCheckpoints:
      root.effectiveLastCheckpoints === 2 || root.effectiveLastCheckpoints === 3 ? root.effectiveLastCheckpoints : 1,
    status: root.status === 'policy_ready' ? 'policy_ready' : 'queued',
  };
}

export function parseStudioNewReviewStartStreamEvent(payload: unknown): StudioNewReviewStartStreamEvent {
  const root = asRecord(payload);
  if (root.type === 'stage') {
    const stage =
      root.stage === 'checkpoint' ||
      root.stage === 'entire_context' ||
      root.stage === 'cochange' ||
      root.stage === 'workspace' ||
      root.stage === 'deployment' ||
      root.stage === 'review_creation' ||
      root.stage === 'policy'
        ? root.stage
        : null;
    if (!stage) {
      throw new Error('Invalid Studio start payload: stage is invalid.');
    }
    return {
      type: 'stage',
      stage,
      state: root.state === 'active' ? 'active' : 'completed',
      label: readString(root.label, 'label'),
      detail: readString(root.detail, 'detail'),
    };
  }
  if (root.type === 'completed') {
    const parsed = parseStudioNewReviewStartResponse(root);
    return {
      type: 'completed',
      ...parsed,
      detail: readString(root.detail, 'detail'),
    };
  }
  if (root.type === 'error') {
    return {
      type: 'error',
      message: readString(root.message, 'message'),
    };
  }
  throw new Error('Invalid Studio start payload: type is invalid.');
}

function parseStudioSessionActivitySnapshotValue(value: unknown): StudioSessionActivitySnapshot {
  const root = asRecord(value);
  const state =
    root.state === 'active' || root.state === 'waiting_on_human' || root.state === 'terminal' ? root.state : null;
  if (!state) {
    throw new Error('Invalid Studio session activity payload: state is invalid.');
  }
  return {
    sessionId: readString(root.sessionId, 'activity.sessionId'),
    phase: readSessionPhase(root.phase),
    state,
    currentReviewStatus:
      root.currentReviewStatus === null || root.currentReviewStatus === undefined ? null : readStatus(root.currentReviewStatus),
    activeReviewId: readOptionalString(root.activeReviewId),
    latestReviewId: readOptionalString(root.latestReviewId),
    passCount: Number(root.passCount) || 0,
    summary: readString(root.summary, 'activity.summary'),
    detail: readString(root.detail, 'activity.detail'),
    canStream: root.canStream === true,
    streamPath: readString(root.streamPath, 'activity.streamPath'),
    updatedAt: readString(root.updatedAt, 'activity.updatedAt'),
  };
}

function parseStudioLocalReviewEnvironment(value: unknown): StudioLocalReviewEnvironment {
  const root = asRecord(value);
  const base = parseLocalReviewEnvironment(root);
  return {
    ...base,
    diffPath: readString(root.diffPath, 'environment.diffPath'),
    mergeBackPath: readString(root.mergeBackPath, 'environment.mergeBackPath'),
  };
}

function parseStudioSessionFindingRollupEntry(value: unknown, label: string): StudioSessionFindingRollupEntry {
  const root = asRecord(value);
  const parsedFinding = readFindings([root.finding])[0];
  if (!parsedFinding) {
    throw new Error(`Invalid Studio session payload: ${label}.finding is invalid.`);
  }
  return {
    finding: parsedFinding,
    state: root.state === 'unresolved' ? 'unresolved' : 'resolved',
    firstSeenReviewId: readString(root.firstSeenReviewId, `${label}.firstSeenReviewId`),
    lastSeenReviewId: readString(root.lastSeenReviewId, `${label}.lastSeenReviewId`),
    reviewIds: readStringList(root.reviewIds),
  };
}

export function parseStudioSessionActivitySnapshotResponse(payload: unknown): StudioSessionActivitySnapshotResponse {
  const root = asRecord(payload);
  return {
    sessionId: readString(root.sessionId, 'sessionId'),
    activity: parseStudioSessionActivitySnapshotValue(root.activity),
  };
}

export function parseStudioSessionActivityEvent(payload: unknown): StudioSessionActivityEvent {
  const root = asRecord(payload);
  if (root.type === 'snapshot') {
    return {
      type: 'snapshot',
      sessionId: readString(root.sessionId, 'sessionId'),
      activity: parseStudioSessionActivitySnapshotValue(root.activity),
    };
  }
  if (root.type === 'terminal') {
    return {
      type: 'terminal',
      sessionId: readString(root.sessionId, 'sessionId'),
      activity: parseStudioSessionActivitySnapshotValue(root.activity),
    };
  }
  if (root.type === 'error') {
    return {
      type: 'error',
      sessionId: readOptionalString(root.sessionId),
      message: readString(root.message, 'message'),
    };
  }
  if (root.type === 'activity') {
    const kind =
      root.kind === 'policy' ||
      root.kind === 'progress' ||
      root.kind === 'finding' ||
      root.kind === 'remediation' ||
      root.kind === 'terminal' ||
      root.kind === 'status'
        ? root.kind
        : null;
    if (!kind) {
      throw new Error('Invalid Studio session activity payload: kind is invalid.');
    }
    return {
      type: 'activity',
      sessionId: readString(root.sessionId, 'sessionId'),
      reviewId: readString(root.reviewId, 'reviewId'),
      passIndex: Number(root.passIndex) || 0,
      rawType: readString(root.rawType, 'rawType'),
      kind,
      label: readString(root.label, 'label'),
      detail: readString(root.detail, 'detail'),
      createdAt: root.createdAt === undefined ? null : readNullableTimestamp(root.createdAt, 'createdAt'),
      seq: root.seq === null || root.seq === undefined ? null : Number(root.seq) || 0,
      payload: asRecord(root.payload),
    };
  }
  throw new Error('Invalid Studio session activity payload: type is invalid.');
}

export function parseStudioSessionAggregateResponse(payload: unknown): StudioSessionAggregateResponse {
  const root = asRecord(payload);
  const findings = asRecord(root.findings);
  const local = asRecord(root.local);
  const capabilities = asRecord(root.capabilities);
  const paths = asRecord(root.paths);
  const adopt = asRecord(root.adopt);
  const reviewedDiff = asRecord(root.reviewedDiff);
  const unresolved = Array.isArray(findings.unresolved) ? readFindings(findings.unresolved) : [];

  return {
    session: parseReviewSessionResponse(root.session),
    reviews: Array.isArray(root.reviews) ? root.reviews.map((item) => parseGetReviewResponse({ review: item }).review) : [],
    latestReview:
      root.latestReview === null || root.latestReview === undefined
        ? null
        : parseGetReviewResponse({ review: root.latestReview }).review,
    activeReview:
      root.activeReview === null || root.activeReview === undefined
        ? null
        : parseGetReviewResponse({ review: root.activeReview }).review,
    findings: {
      unresolved,
      resolved: Array.isArray(findings.resolved)
        ? findings.resolved.map((item, index) => parseStudioSessionFindingRollupEntry(item, `findings.resolved[${index}]`))
        : [],
      all: Array.isArray(findings.all)
        ? findings.all.map((item, index) => parseStudioSessionFindingRollupEntry(item, `findings.all[${index}]`))
        : [],
    },
    activity: parseStudioSessionActivitySnapshotValue(root.activity),
    reviewedDiff: {
      sessionId: readString(reviewedDiff.sessionId, 'reviewedDiff.sessionId'),
      reviewId: readOptionalString(reviewedDiff.reviewId),
      available: reviewedDiff.available === true,
      status:
        reviewedDiff.status === 'available' || reviewedDiff.status === 'error' || reviewedDiff.status === 'unavailable'
          ? reviewedDiff.status
          : 'unavailable',
      reason: readOptionalString(reviewedDiff.reason),
      path: readString(reviewedDiff.path, 'reviewedDiff.path'),
      environmentRevision:
        reviewedDiff.environmentRevision === null || reviewedDiff.environmentRevision === undefined
          ? null
          : (readEnvironmentRevision(reviewedDiff.environmentRevision) ?? null),
      diff: reviewedDiff.diff === undefined ? undefined : parseWorkspaceDiffResponse(reviewedDiff.diff),
    } satisfies StudioReviewedDiffResponse,
    local: {
      environments: Array.isArray(local.environments) ? local.environments.map((item) => parseStudioLocalReviewEnvironment(item)) : [],
      hasAny: local.hasAny === true,
    },
    capabilities: {
      active: capabilities.active === true,
      waitingOnHuman: capabilities.waitingOnHuman === true,
      terminal: capabilities.terminal === true,
      canShowReviewedDiff: capabilities.canShowReviewedDiff === true,
      canAdopt: capabilities.canAdopt === true,
      canListLocalEnvironments: capabilities.canListLocalEnvironments === true,
      canShowLocalDiff: capabilities.canShowLocalDiff === true,
      canMergeBack: capabilities.canMergeBack === true,
    },
    paths: {
      self: readString(paths.self, 'paths.self'),
      activity: readString(paths.activity, 'paths.activity'),
      activityEvents: readString(paths.activityEvents, 'paths.activityEvents'),
      reviewedDiff: readString(paths.reviewedDiff, 'paths.reviewedDiff'),
      localEnvironments: readString(paths.localEnvironments, 'paths.localEnvironments'),
      adopt: readString(paths.adopt, 'paths.adopt'),
    },
    adopt: {
      available: adopt.available === true,
      reason: readOptionalString(adopt.reason),
      path: readString(adopt.path, 'adopt.path'),
      modes: Array.isArray(adopt.modes)
        ? adopt.modes.filter((item): item is 'worktree' | 'branch' => item === 'worktree' || item === 'branch')
        : [],
    },
  };
}
