import type {
  ReviewContextMode,
  ReviewFinding,
  ReviewPolicyDraft,
  ReviewResponse,
  ReviewSessionPhase,
  ReviewSessionResponse,
  ReviewStatus,
  ReviewEnvironmentRevision,
} from '../review/contracts';

export interface StudioContextResponse {
  repo: string | null;
  branch: string | null;
  detectedAt: string;
}

export type StudioPolicyMode = 'auto' | 'review';

export interface StudioNewReviewPreflightCheck {
  code: 'checkpoint' | 'entire_context';
  label: string;
  ok: boolean;
  detail: string;
}

export type StudioPreflightIssueCode =
  | 'checkpoint_unavailable'
  | 'checkpoint_missing_trailer'
  | 'entire_context_unavailable'
  | 'branch_context_changed'
  | 'unknown';

export interface StudioPreflightIssue {
  code: StudioPreflightIssueCode;
  message: string;
}

export interface StudioNewReviewPreflightCapabilities {
  canStart: boolean;
  canStartInBasicMode: boolean;
  canStartInIntentAwareMode: boolean;
  canReviewPolicy: boolean;
}

export interface StudioNewReviewPreflightResponse {
  repo: string | null;
  branch: string | null;
  policyMode: StudioPolicyMode;
  startability: 'blocked' | 'basic' | 'intent_aware';
  contextMode: ReviewContextMode;
  requestedLastCheckpoints: 1 | 2 | 3;
  effectiveLastCheckpoints: 1 | 2 | 3;
  lastCheckpoints: 1 | 2 | 3;
  checkpointSelectionMode: 'latest' | 'last_n';
  checkpointId: string | null;
  commitSha: string | null;
  includedCheckpoints: Array<{
    checkpointId: string;
    commitSha: string;
    commitSubject: string;
  }>;
  ready: boolean;
  capabilities: StudioNewReviewPreflightCapabilities;
  blockingIssues: StudioPreflightIssue[];
  warnings: StudioPreflightIssue[];
  checks: StudioNewReviewPreflightCheck[];
  error?: {
    code: StudioPreflightIssueCode;
    message: string;
  };
}

export interface StudioNewReviewStartResponse {
  reviewId: string;
  sessionId: string | null;
  routePath: string;
  policyMode: StudioPolicyMode;
  contextMode: ReviewContextMode;
  requestedLastCheckpoints: 1 | 2 | 3;
  effectiveLastCheckpoints: 1 | 2 | 3;
  status: 'policy_ready' | 'queued';
}

export type StudioNewReviewStartStage =
  | 'checkpoint'
  | 'entire_context'
  | 'cochange'
  | 'workspace'
  | 'deployment'
  | 'review_creation'
  | 'policy';

export interface StudioNewReviewStartStageEvent {
  type: 'stage';
  stage: StudioNewReviewStartStage;
  state: 'active' | 'completed';
  label: string;
  detail: string;
}

export interface StudioNewReviewStartCompletedEvent extends StudioNewReviewStartResponse {
  type: 'completed';
  detail: string;
}

export interface StudioNewReviewStartErrorEvent {
  type: 'error';
  message: string;
}

export type StudioNewReviewStartStreamEvent =
  | StudioNewReviewStartStageEvent
  | StudioNewReviewStartCompletedEvent
  | StudioNewReviewStartErrorEvent;

export type WorkspaceDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceDiffFile {
  path: string;
  status: WorkspaceDiffStatus;
  previousPath?: string;
}

export interface WorkspaceDiffResponse {
  workspaceId: string;
  includePatch: boolean;
  maxBytes: number;
  truncated: boolean;
  changedFilesTruncated?: boolean;
  patchTruncated?: boolean;
  summaryIsPartial?: boolean;
  summary: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    totalChanged: number;
  };
  changedFiles: WorkspaceDiffFile[];
  changedFilesBytes?: number;
  changedFilesTotalBytes?: number;
  patch?: string;
  patchBytes?: number;
  patchTotalBytes?: number;
}

export interface LocalReviewEnvironment {
  sessionId: string;
  repoRoot: string;
  repo: string | null;
  branchName: string;
  mode: 'worktree' | 'branch';
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  environmentRevision: ReviewEnvironmentRevision;
  contextMode: ReviewContextMode | 'unknown';
  materializedAt: string;
  enterCommand: string;
}

export interface LocalReviewEnvironmentListResponse {
  environments: LocalReviewEnvironment[];
}

export interface LocalReviewEnvironmentDiffResponse {
  entry: LocalReviewEnvironment;
  baseRef: string;
  diff: string;
  hasDiff: boolean;
  enterCommand: string;
}

export interface LocalReviewEnvironmentMergeBackResponse {
  sessionId: string;
  currentBranch: string;
  sourceBranch: string;
  sourceCommit: string;
  newHead: string | null;
  worktreePath: string | null;
  status: 'applied' | 'already_applied';
}

export interface StudioAdoptResponse {
  sessionId: string;
  mode: 'worktree' | 'branch';
  branchName: string;
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  enterCommand: string;
}

export interface StudioSessionActivitySnapshot {
  sessionId: string;
  phase: ReviewSessionPhase;
  state: 'active' | 'waiting_on_human' | 'terminal';
  currentReviewStatus: ReviewStatus | null;
  activeReviewId: string | null;
  latestReviewId: string | null;
  passCount: number;
  summary: string;
  detail: string;
  canStream: boolean;
  streamPath: string;
  updatedAt: string;
}

export interface StudioSessionActivitySnapshotResponse {
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityEntry {
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

export interface StudioSessionActivityStreamSnapshotEvent {
  type: 'snapshot';
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityStreamTerminalEvent {
  type: 'terminal';
  sessionId: string;
  activity: StudioSessionActivitySnapshot;
}

export interface StudioSessionActivityStreamErrorEvent {
  type: 'error';
  sessionId?: string | null;
  message: string;
}

export type StudioSessionActivityEvent =
  | StudioSessionActivityStreamSnapshotEvent
  | StudioSessionActivityEntry
  | StudioSessionActivityStreamTerminalEvent
  | StudioSessionActivityStreamErrorEvent;

export interface StudioSessionFindingRollupEntry {
  finding: ReviewFinding;
  state: 'resolved' | 'unresolved';
  firstSeenReviewId: string;
  lastSeenReviewId: string;
  reviewIds: string[];
}

export interface StudioLocalReviewEnvironment extends LocalReviewEnvironment {
  diffPath: string;
  mergeBackPath: string;
}

export interface StudioReviewedDiffResponse {
  sessionId: string;
  reviewId: string | null;
  available: boolean;
  status: 'available' | 'unavailable' | 'error';
  reason: string | null;
  path: string;
  environmentRevision: ReviewEnvironmentRevision | null;
  diff?: WorkspaceDiffResponse;
}

export interface StudioSessionAggregateResponse {
  session: ReviewSessionResponse;
  reviews: ReviewResponse[];
  latestReview: ReviewResponse | null;
  activeReview: ReviewResponse | null;
  findings: {
    unresolved: ReviewFinding[];
    resolved: StudioSessionFindingRollupEntry[];
    all: StudioSessionFindingRollupEntry[];
  };
  activity: StudioSessionActivitySnapshot;
  reviewedDiff: StudioReviewedDiffResponse;
  local: {
    environments: StudioLocalReviewEnvironment[];
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
}

export interface StudioPolicyApproval {
  reviewId: string;
  approvedPolicy: ReviewPolicyDraft;
}
