import type {
  LocalReviewEnvironmentDiffResponse,
  ReviewContextMode,
  ReviewFinding,
  ReviewSessionResponse,
  StudioAdoptResponse,
  StudioSessionActivityEntry,
  StudioSessionActivitySnapshot,
  StudioSessionAggregateResponse,
} from '../../types';

export interface ActivityConsoleEntry {
  id: string;
  kind: StudioSessionActivityEntry['kind'] | 'snapshot';
  createdAt: string | null;
  passIndex: number | null;
  line: string;
  checkpoint: boolean;
}

export interface SessionFindingViewModel {
  key: string;
  severity: string;
  severityClass: string;
  heading: string;
  description: string | null;
  location: string | null;
  suggestedFix: string | null;
}

export interface SessionViewModel {
  sessionId: string;
  repoBranchLabel: string;
  phaseLabel: string;
  stageTitle: string;
  stageTone: 'starting' | 'ready' | 'basic' | 'blocked';
  stageDetail: string;
  contextMode: ReviewContextMode | null;
  showBasicModeNotice: boolean;
  isWaitingOnHuman: boolean;
  isTerminal: boolean;
  policy: {
    reviewId: string | null;
    editable: boolean;
  };
  activity: {
    heading: string;
    subtle: string;
    passCountLabel: string;
    modeLabel: string;
    streamLabel: string;
    entries: ActivityConsoleEntry[];
  };
  findings: {
    liveSubtle: string;
    unresolved: SessionFindingViewModel[];
    resolved: SessionFindingViewModel[];
  };
  result: {
    outcomeLabel: string;
    summary: string;
    recommendation: string;
    unresolvedCount: number;
    changedFiles: number;
    changedSummary: string;
  } | null;
  reviewedDiff: {
    visible: boolean;
    summaryItems: string[];
    files: Array<{ status: string; path: string }>;
    patch: string | null;
    emptyMessage: string;
  };
  adopt: {
    canAdopt: boolean;
    hasLocalEnvironment: boolean;
    reason: string | null;
    primaryEnvironment: StudioSessionAggregateResponse['local']['environments'][number] | null;
    adoptResult: StudioAdoptResponse | null;
    noAdoptVisible: boolean;
    noAdoptTitle: string;
    noAdoptDetail: string;
  };
  localDiff: {
    visible: boolean;
    data: LocalReviewEnvironmentDiffResponse | null;
  };
  mergeBack: {
    visible: boolean;
  };
}

function resolveContextMode(aggregate: StudioSessionAggregateResponse): ReviewContextMode | null {
  return (
    aggregate.session.outcome?.reviewed.contextMode ??
    aggregate.latestReview?.provenance.reviewContextMode ??
    aggregate.activeReview?.provenance.reviewContextMode ??
    null
  );
}

function modeLabel(mode: ReviewContextMode | null): string {
  if (mode === 'intent_aware') {
    return 'Intent-aware';
  }
  if (mode === 'basic') {
    return 'Basic';
  }
  return 'Pending';
}

function severityClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') {
    return 'severity-pill danger';
  }
  if (severity === 'medium') {
    return 'severity-pill warning';
  }
  return 'severity-pill neutral';
}

function findingHeading(finding: ReviewFinding): string {
  return finding.title?.trim() || finding.description;
}

function shouldShowFindingDescription(finding: ReviewFinding): boolean {
  const heading = findingHeading(finding).trim();
  const description = finding.description.trim();
  return Boolean(description) && description !== heading;
}

function findingLocation(finding: ReviewFinding): string | null {
  const first = finding.locations[0];
  if (!first) {
    return null;
  }
  if (first.startLine !== null) {
    return `${first.filePath}:${first.startLine}`;
  }
  return first.filePath;
}

function buildFindingViewModel(finding: ReviewFinding, index: number): SessionFindingViewModel {
  return {
    key: `${findingHeading(finding)}-${findingLocation(finding) ?? index}`,
    severity: finding.severity,
    severityClass: severityClass(finding.severity),
    heading: findingHeading(finding),
    description: shouldShowFindingDescription(finding) ? finding.description : null,
    location: findingLocation(finding),
    suggestedFix: finding.suggestedFix.trim() ? finding.suggestedFix : null,
  };
}

function buildStreamedFinding(event: StudioSessionActivityEntry, index: number): {
  title: string;
  description: string;
  location: string | null;
} | null {
  if (event.kind !== 'finding') {
    return null;
  }
  const payload = event.payload;
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : typeof payload.description === 'string' && payload.description.trim()
        ? payload.description.trim()
        : event.detail;
  const locations = Array.isArray(payload.locations) ? payload.locations : [];
  const firstLocation = locations[0];
  let location: string | null = null;
  if (firstLocation && typeof firstLocation === 'object' && !Array.isArray(firstLocation)) {
    const record = firstLocation as { path?: unknown; line?: unknown };
    if (typeof record.path === 'string' && record.path.trim()) {
      location =
        typeof record.line === 'number' && Number.isFinite(record.line) ? `${record.path}:${record.line}` : record.path;
    }
  }
  return {
    title,
    description: typeof payload.description === 'string' && payload.description.trim() ? payload.description : event.detail,
    location,
  };
}

function formatActivityConsoleTime(value: string | null): string {
  if (!value) {
    return '--:--:--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatActivityConsoleTimestamp(value: string | null): string {
  return formatActivityConsoleTime(value);
}

export function activityConsoleKindLabel(kind: ActivityConsoleEntry['kind']): string {
  if (kind === 'snapshot') {
    return 'snapshot';
  }
  return kind.replace(/_/g, ' ');
}

function buildActivityConsoleEntry(event: StudioSessionActivityEntry, index: number): ActivityConsoleEntry {
  const finding = buildStreamedFinding(event, index);
  const line = finding
    ? `${finding.title}${finding.location ? ` (${finding.location})` : ''}${finding.description !== finding.title ? ` - ${finding.description}` : ''}`
    : event.detail.trim() === event.label.trim()
      ? event.detail
      : `${event.label}: ${event.detail}`;
  return {
    id: `${event.reviewId}-${event.seq ?? index}-${event.rawType}-${index}`,
    kind: event.kind,
    createdAt: event.createdAt,
    passIndex: event.passIndex,
    line,
    checkpoint: false,
  };
}

function buildActivitySnapshotEntry(activity: StudioSessionActivitySnapshot | null): ActivityConsoleEntry {
  if (!activity) {
    return {
      id: 'snapshot-empty',
      kind: 'snapshot',
      createdAt: null,
      passIndex: null,
      line: 'Waiting for session activity.',
      checkpoint: false,
    };
  }
  return {
    id: `snapshot-${activity.updatedAt}-${activity.state}-${activity.currentReviewStatus ?? 'none'}`,
    kind: 'snapshot',
    createdAt: activity.updatedAt,
    passIndex: activity.passCount > 0 ? Math.max(0, activity.passCount - 1) : null,
    line: activity.detail,
    checkpoint: false,
  };
}

function markCheckpoint(entries: ActivityConsoleEntry[], enabled: boolean): ActivityConsoleEntry[] {
  if (!enabled) {
    return entries;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === 'policy') {
      return entries.map((entry, entryIndex) => ({
        ...entry,
        checkpoint: entryIndex === index,
      }));
    }
  }
  return entries;
}

function sessionPhaseLabel(phase: ReviewSessionResponse['phase']): string {
  return phase.replace(/_/g, ' ');
}

function sessionStageTitle(input: {
  phase: ReviewSessionResponse['phase'];
  terminal: boolean;
  waiting: boolean;
}): string {
  if (input.phase === 'failed') {
    return 'Review failed';
  }
  if (input.phase === 'cancelled') {
    return 'Review cancelled';
  }
  if (input.waiting) {
    return 'Review paused';
  }
  if (input.terminal) {
    return 'Review complete';
  }
  return 'Review in progress';
}

function sessionTone(input: {
  phase: ReviewSessionResponse['phase'];
  terminal: boolean;
  waiting: boolean;
}): 'starting' | 'ready' | 'basic' | 'blocked' {
  if (input.phase === 'failed' || input.phase === 'cancelled') {
    return 'blocked';
  }
  if (input.waiting) {
    return 'basic';
  }
  if (input.phase === 'preparing') {
    return 'starting';
  }
  return 'ready';
}

function recommendationLabel(aggregate: StudioSessionAggregateResponse, canShowReviewedDiff: boolean): string {
  if (aggregate.capabilities.canAdopt && aggregate.adopt.available && canShowReviewedDiff) {
    return 'Adopt locally';
  }
  return aggregate.session.outcome?.recommendation?.replace(/_/g, ' ') ?? 'Manual follow-up';
}

export function buildSessionViewModel(input: {
  aggregate: StudioSessionAggregateResponse;
  activity: StudioSessionActivitySnapshot;
  events: StudioSessionActivityEntry[];
  localDiff: LocalReviewEnvironmentDiffResponse | null;
  adoptResult: StudioAdoptResponse | null;
}): SessionViewModel {
  const { aggregate, activity, events, localDiff, adoptResult } = input;
  const isWaitingOnHuman = aggregate.capabilities.waitingOnHuman === true;
  const isTerminal = aggregate.capabilities.terminal === true;
  const contextMode = resolveContextMode(aggregate);
  const activeReview = aggregate.activeReview ?? null;
  const canShowReviewedDiff = aggregate.capabilities.canShowReviewedDiff === true && aggregate.reviewedDiff.available;
  const primaryEnvironment = aggregate.local.environments[0] ?? null;
  const canAdopt = aggregate.capabilities.canAdopt === true && aggregate.adopt.available;
  const unresolvedFindings = aggregate.findings.unresolved.map((finding, index) => buildFindingViewModel(finding, index));
  const resolvedFindings = aggregate.findings.resolved.map((entry, index) => buildFindingViewModel(entry.finding, index));
  const liveEntries = events.map((event, index) => buildActivityConsoleEntry(event, index));
  const snapshotEntry = buildActivitySnapshotEntry(activity);
  const consoleEntries = liveEntries.length === 0
    ? [snapshotEntry]
    : isTerminal || isWaitingOnHuman
      ? (() => {
          const lastEntry = liveEntries[liveEntries.length - 1];
          if (lastEntry.line !== snapshotEntry.line || lastEntry.kind !== snapshotEntry.kind) {
            return [...liveEntries, snapshotEntry];
          }
          return liveEntries;
        })()
      : liveEntries;

  const resultChangedFiles =
    aggregate.reviewedDiff.diff?.summary.totalChanged ?? aggregate.session.outcome?.changes.changedFileCount ?? 0;
  const reviewedDiffSummary = aggregate.reviewedDiff.diff
    ? [
        `${aggregate.reviewedDiff.diff.summary.totalChanged} file(s) changed`,
        aggregate.reviewedDiff.environmentRevision?.changedFileCount
          ? `${aggregate.reviewedDiff.environmentRevision.changedFileCount} file(s) in reviewed revision`
          : null,
        aggregate.reviewedDiff.diff.truncated ? 'Diff truncated for display' : null,
      ].filter((item): item is string => Boolean(item))
    : [];
  const noAdoptTitle = aggregate.session.phase === 'failed' ? 'No reviewed result' : 'No reviewed result to adopt';
  const noAdoptDetail =
    aggregate.reviewedDiff.reason ??
    (aggregate.session.phase === 'failed'
      ? 'Nimbus failed before it could publish a reviewed diff. Review the final console output and the unresolved findings before deciding whether to retry on a new commit.'
      : `Nimbus did not produce a remediated result for this session, so there is nothing to adopt locally.${
          unresolvedFindings.length > 0
            ? ' Address the remaining findings manually, commit that work, then start a new review on the new commit.'
            : ''
        }`);

  return {
    sessionId: aggregate.session.id,
    repoBranchLabel: `${aggregate.session.repo} · ${aggregate.session.branch}`,
    phaseLabel: sessionPhaseLabel(aggregate.session.phase),
    stageTitle: sessionStageTitle({
      phase: aggregate.session.phase,
      terminal: isTerminal,
      waiting: isWaitingOnHuman,
    }),
    stageTone: sessionTone({
      phase: aggregate.session.phase,
      terminal: isTerminal,
      waiting: isWaitingOnHuman,
    }),
    stageDetail: activity.detail,
    contextMode,
    showBasicModeNotice: contextMode === 'basic',
    isWaitingOnHuman,
    isTerminal,
    policy: {
      reviewId: activeReview?.id ?? null,
      editable: activeReview?.status === 'policy_ready' && Boolean(activeReview.derivedPolicy),
    },
    activity: {
      heading: isTerminal ? 'Final session output' : 'Live review console',
      subtle:
        activity.canStream && !isTerminal
          ? 'New SSE events stream into this pane. Scroll stays inside the console, not the page.'
          : 'Recent session output for this browser session.',
      passCountLabel: `${aggregate.session.passCount} pass${aggregate.session.passCount === 1 ? '' : 'es'}`,
      modeLabel: modeLabel(contextMode),
      streamLabel: activity.canStream && !isTerminal ? 'live tail' : 'snapshot',
      entries: markCheckpoint(consoleEntries, isWaitingOnHuman),
    },
    findings: {
      liveSubtle: isWaitingOnHuman
        ? 'These findings remain open while the session waits for your decision.'
        : 'Findings appear here as Nimbus emits them.',
      unresolved: unresolvedFindings,
      resolved: resolvedFindings,
    },
    result: isTerminal
      ? {
          outcomeLabel: aggregate.session.outcome?.kind.replace(/_/g, ' ') ?? activity.summary,
          summary: aggregate.session.outcome?.summary ?? activity.summary,
          recommendation: recommendationLabel(aggregate, canShowReviewedDiff),
          unresolvedCount: aggregate.session.outcome?.unresolved.findingCount ?? unresolvedFindings.length,
          changedFiles: resultChangedFiles,
          changedSummary: aggregate.session.outcome?.changes.summaries[0] ?? 'Nimbus did not publish a remediation summary.',
        }
      : null,
    reviewedDiff: {
      visible: canShowReviewedDiff && Boolean(aggregate.reviewedDiff.diff),
      summaryItems: reviewedDiffSummary,
      files: aggregate.reviewedDiff.diff?.changedFiles ?? [],
      patch: aggregate.reviewedDiff.diff?.patch?.trim() ? aggregate.reviewedDiff.diff.patch : null,
      emptyMessage:
        aggregate.reviewedDiff.reason ??
        'Nimbus finished this session without publishing a remediated worktree diff. This run is findings-only.',
    },
    adopt: {
      canAdopt,
      hasLocalEnvironment: Boolean(primaryEnvironment),
      reason: aggregate.adopt.reason,
      primaryEnvironment,
      adoptResult,
      noAdoptVisible: !primaryEnvironment && !canAdopt,
      noAdoptTitle,
      noAdoptDetail,
    },
    localDiff: {
      visible: Boolean(primaryEnvironment),
      data: localDiff,
    },
    mergeBack: {
      visible: Boolean(primaryEnvironment),
    },
  };
}
