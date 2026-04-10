import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyToClipboard } from '../lib/clipboard';
import { downloadTextFile } from '../lib/download';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import {
  buildFindingText,
  dateTimeLabel,
  findingCount,
  findingLocationsText,
  parseGetReviewResponse,
  reviewFailureGuidance,
  statusNarrative,
} from '../lib/review';
import type { GetReviewResponse, ReviewFinding, ReviewResponse, ReviewSeverity } from '../types';
import { cn } from '../lib/utils';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';
type TimelinePhaseState = 'completed' | 'active' | 'pending';

const VALID_STATUSES: ReadonlySet<ReviewResponse['status']> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

const LIVE_STREAM_STATUSES: ReadonlySet<ReviewResponse['status']> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

const FINDING_SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface ActivityLogEntry {
  id: string;
  timestamp: number;
  label: string;
  detail?: string;
}

const EVENT_LABELS: Record<string, string> = {
  review_created: 'Review created',
  review_enqueued: 'Queued for execution',
  review_policy_derivation_started: 'Deriving policy from session context',
  review_policy_derivation_completed: 'Policy derivation complete',
  review_policy_approved: 'Policy approved',
  review_context_assembly_started: 'Assembling review context',
  review_context_checkpoint_context_collected: 'Checkpoint context collected',
  review_context_diff_collected: 'Diff collected',
  review_context_changed_files_collected: 'Changed files collected',
  review_context_conventions_collected: 'Conventions collected',
  review_context_cochange_lookup_started: 'Looking up co-change history',
  review_context_cochange_lookup_completed: 'Co-change lookup complete',
  review_context_cochange_failed: 'Co-change lookup failed',
  review_context_budget_checked: 'Token budget checked',
  review_context_stored: 'Review context stored',
  review_context_assembly_succeeded: 'Context assembly succeeded',
  review_context_assembly_failed: 'Context assembly failed',
  review_preflight_started: 'Preflight checks started',
  review_preflight_completed: 'Preflight checks passed',
  review_analysis_started: 'Analysis started',
  review_analysis_agent_started: 'Analysis agent initialized',
  review_analysis_prompt_built: 'Prompt constructed',
  review_analysis_provider_request_started: 'Sending to model',
  review_analysis_model_output_received: 'Model output received',
  review_analysis_output_validated: 'Output validated',
  review_analysis_output_validation_failed: 'Output validation failed',
  review_analysis_repair_requested: 'Repair pass requested',
  review_analysis_repair_output_received: 'Repair output received',
  review_analysis_output_fallback_applied: 'Fallback applied',
  review_analysis_agent_completed: 'Analysis agent completed',
  review_finding_emitted: 'Finding emitted',
  review_finalize_started: 'Finalizing review',
  review_analysis_findings_persisted: 'Findings persisted',
  review_analysis_succeeded: 'Analysis succeeded',
  review_succeeded: 'Review succeeded',
  review_failed: 'Review failed',
  review_cancelled: 'Review cancelled',
  review_retry_scheduled: 'Retry scheduled',
};

function statusFromReviewEventType(eventType: string): ReviewResponse['status'] | null {
  switch (eventType) {
    case 'review_created':
    case 'review_enqueued':
      return 'queued';
    case 'review_succeeded':
      return 'succeeded';
    case 'review_failed':
      return 'failed';
    case 'review_cancelled':
      return 'cancelled';
    case 'review_policy_approved':
      return 'policy_approved';
    default:
      return null;
  }
}

function eventToLogEntry(eventType: string, data: Record<string, unknown>): ActivityLogEntry | null {
  if (eventType === 'heartbeat' || eventType === 'snapshot' || eventType === 'terminal') {
    return null;
  }
  const label = EVENT_LABELS[eventType] ?? eventType.replace(/_/g, ' ');
  let detail: string | undefined;

  if (eventType === 'review_analysis_provider_request_started' && typeof data.step === 'number') {
    detail = `Step ${data.step}`;
  } else if (eventType === 'review_analysis_model_output_received' && typeof data.step === 'number') {
    detail = data.repairAttempted ? `Step ${data.step} (repair)` : `Step ${data.step}`;
  } else if (eventType === 'review_finding_emitted') {
    detail = typeof data.description === 'string' ? data.description : undefined;
  } else if (eventType === 'review_context_changed_files_collected' && typeof data.changedFileCount === 'number') {
    detail = `${data.changedFileCount} files`;
  } else if (eventType === 'review_analysis_agent_started' && typeof data.model === 'string') {
    detail = data.model;
  } else if (eventType === 'review_context_budget_checked') {
    if (typeof data.estimatedTokens === 'number' && typeof data.tokenBudget === 'number') {
      detail = `${data.estimatedTokens.toLocaleString()} / ${data.tokenBudget.toLocaleString()} tokens`;
    }
  } else if (eventType === 'review_failed' && typeof data.message === 'string') {
    detail = data.message;
  } else if (eventType === 'review_succeeded' && typeof data.findingCount === 'number') {
    detail = `${data.findingCount} finding${data.findingCount === 1 ? '' : 's'}`;
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    label,
    detail,
  };
}

interface TimelinePhase {
  key: string;
  label: string;
  state: TimelinePhaseState;
  durationMs: number | null;
  detail: string;
}

interface ReviewedFilesSection {
  key: 'changed' | 'related' | 'conventions';
  label: string;
  files: string[];
}

function severityColor(severity: ReviewFinding['severity']): string {
  switch (severity) {
    case 'critical':
      return 'text-red-700 bg-red-50 border-red-200';
    case 'high':
      return 'text-orange-700 bg-orange-50 border-orange-200';
    case 'medium':
      return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'low':
      return 'text-sky-700 bg-sky-50 border-sky-200';
    default:
      return 'text-slate-600 bg-slate-50 border-slate-200';
  }
}

function severityBarColor(severity: Exclude<ReviewSeverity, 'info'>): string {
  if (severity === 'critical') {
    return 'bg-red-500';
  }
  if (severity === 'high') {
    return 'bg-orange-500';
  }
  if (severity === 'medium') {
    return 'bg-amber-500';
  }
  return 'bg-sky-500';
}

function recommendationTone(recommendation: string | undefined): {
  containerClass: string;
  labelClass: string;
} {
  if (recommendation === 'approve') {
    return {
      containerClass: 'border-emerald-200 bg-emerald-50/45',
      labelClass: 'text-emerald-900',
    };
  }
  if (recommendation === 'comment') {
    return {
      containerClass: 'border-amber-200 bg-amber-50/50',
      labelClass: 'text-amber-900',
    };
  }
  if (recommendation === 'request_changes') {
    return {
      containerClass: 'border-red-200 bg-red-50/50',
      labelClass: 'text-red-900',
    };
  }
  return {
    containerClass: 'border-border bg-card/70',
    labelClass: 'text-foreground',
  };
}

function phaseStateClass(state: TimelinePhaseState): string {
  if (state === 'completed') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  if (state === 'active') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  return 'border-border bg-muted/50 text-muted-foreground';
}

function riskLevelClass(riskLevel: 'critical' | 'high' | 'medium' | 'low' | undefined): string {
  if (riskLevel === 'critical') {
    return 'border-red-200 bg-red-50 text-red-800';
  }
  if (riskLevel === 'high') {
    return 'border-orange-200 bg-orange-50 text-orange-800';
  }
  if (riskLevel === 'medium') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  if (riskLevel === 'low') {
    return 'border-sky-200 bg-sky-50 text-sky-800';
  }
  return 'border-border bg-muted/50 text-muted-foreground';
}

function evidenceStatusClass(status: ReviewResponse['evidence'][number]['status']): string {
  if (status === 'passed') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  if (status === 'failed') {
    return 'border-rose-200 bg-rose-50 text-rose-800';
  }
  if (status === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  return 'border-border bg-muted/50 text-muted-foreground';
}

function compactNumber(value: number): string {
  return value.toLocaleString();
}

function primaryVerdictHeadline(review: ReviewResponse, totalFindings: number): string {
  if (review.status === 'succeeded') {
    if (totalFindings === 0) {
      return 'No actionable findings identified';
    }
    return `${totalFindings} finding${totalFindings === 1 ? '' : 's'} require attention`;
  }
  if (review.status === 'failed') {
    return 'Review failed before completion';
  }
  if (review.status === 'cancelled') {
    return 'Review was cancelled';
  }
  return statusNarrative(review).title;
}

function findingsEmptyState(review: ReviewResponse): string {
  if (LIVE_STREAM_STATUSES.has(review.status)) {
    return 'Findings will appear here as Nimbus finishes the review.';
  }
  if (review.status === 'failed' || review.status === 'cancelled') {
    return 'No findings were persisted before the review stopped.';
  }
  return 'No actionable findings identified.';
}

function reviewedFilesSections(review: ReviewResponse | null): ReviewedFilesSection[] {
  const reviewedFiles = review?.provenance.reviewedFiles;
  if (!reviewedFiles) {
    return [];
  }

  return [
    {
      key: 'changed' as const,
      label: 'Changed in this review',
      files: reviewedFiles.changed,
    },
    {
      key: 'related' as const,
      label: 'Related files',
      files: reviewedFiles.related,
    },
    {
      key: 'conventions' as const,
      label: 'Convention and config files',
      files: reviewedFiles.conventions,
    },
  ].filter((section) => section.files.length > 0);
}

function ReviewedFilesDialog({
  open,
  totalFiles,
  sections,
  onClose,
}: {
  open: boolean;
  totalFiles: number;
  sections: ReviewedFilesSection[];
  onClose: () => void;
}): JSX.Element | null {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/55 p-0 sm:items-center sm:justify-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reviewed-files-title"
        className="max-h-[88vh] w-full overflow-hidden rounded-t-xl border border-border/70 bg-background shadow-2xl sm:max-w-2xl sm:rounded-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border/70 px-4 py-3">
          <div>
            <h2 id="reviewed-files-title" className="text-base font-semibold text-foreground">
              Reviewed files
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{compactNumber(totalFiles)} files included in review context.</p>
          </div>
          <button type="button" className="report-copy-btn text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="max-h-[calc(88vh-80px)] space-y-3 overflow-y-auto px-4 py-4">
          {sections.map((section) => (
            <section key={section.key} className="rounded-sm border border-border/60 bg-card/75 px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-foreground">{section.label}</h3>
                <span className="text-xs text-muted-foreground">{compactNumber(section.files.length)}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {section.files.map((filePath) => (
                  <li key={`${section.key}:${filePath}`} className="rounded-sm border border-border/50 bg-background/75 px-2.5 py-1.5 font-mono text-xs text-foreground">
                    {filePath}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1400px] items-center justify-center px-3 py-4">
      <div className="w-full">{children}</div>
    </main>
  );
}

function normalizeMarkdownSummary(markdown: string | null): string {
  if (!markdown?.trim()) {
    return '';
  }

  const withoutEvidenceSection = markdown
    .split('\n')
    .reduce<{ lines: string[]; skippingEvidence: boolean }>(
      (state, line) => {
        if (/^##\s+Evidence\b/.test(line)) {
          return {
            ...state,
            skippingEvidence: true,
          };
        }

        if (state.skippingEvidence && /^##\s+/.test(line)) {
          return {
            lines: [...state.lines, line],
            skippingEvidence: false,
          };
        }

        if (state.skippingEvidence) {
          return state;
        }

        return {
          ...state,
          lines: [...state.lines, line],
        };
      },
      { lines: [], skippingEvidence: false }
    )
    .lines.join('\n')
    .trim();

  return withoutEvidenceSection.replace(/^(#{1,6})\s+Intent\b/gm, '$1 Policy').trim();
}

function renderedMarkdown(markdown: string): string {
  if (!markdown.trim()) {
    return '<p>No markdown summary available for this review.</p>';
  }
  return DOMPurify.sanitize(marked.parse(markdown) as string);
}

function cochangeStatusMessage(review: ReviewResponse): string | null {
  const coChange = review.provenance.coChange;
  if (!coChange) {
    return null;
  }
  if (coChange.coChangeSkipped) {
    const reason =
      coChange.coChangeSkipReason === 'missing_github_token'
        ? 'missing GitHub token'
        : coChange.coChangeSkipReason === 'rate_limited'
          ? 'GitHub API rate limited'
          : 'GitHub API unavailable';
    return `Co-change context was skipped (${reason}). This review ran with baseline context only. Set REVIEW_CONTEXT_GITHUB_TOKEN to improve review quality.`;
  }
  if (coChange.coChangeAvailable) {
    return `Co-change context included ${coChange.relatedFileCount} related file${coChange.relatedFileCount === 1 ? '' : 's'}.`;
  }
  return 'Co-change lookup ran successfully and found no related files.';
}

function contextResolutionMessage(review: ReviewResponse): string | null {
  const contextResolution = review.provenance.contextResolution;
  if (!contextResolution || contextResolution.contextResolution !== 'branch_fallback') {
    return null;
  }
  const commitLabel = contextResolution.resolvedCommitMessage?.trim()
    ? `${contextResolution.resolvedCommitSha.slice(0, 7)} (${contextResolution.resolvedCommitMessage.trim()})`
    : contextResolution.resolvedCommitSha.slice(0, 7);
  return `Session context used branch fallback: checkpoint ${contextResolution.originalCheckpointId} had no readable context, so this review used checkpoint ${contextResolution.resolvedCheckpointId} from commit ${commitLabel}.`;
}

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function safeDuration(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) {
    return null;
  }
  return end - start;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return 'n/a';
  }
  if (durationMs < 1000) {
    return '<1s';
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function reviewDurationLabel(review: ReviewResponse): string {
  const started = toTimestamp(review.startedAt);
  const finished = toTimestamp(review.finishedAt);

  if (started !== null && finished !== null) {
    return formatDuration(Math.max(0, finished - started));
  }

  if (started !== null && (review.status === 'running' || review.status === 'queued')) {
    return `in progress (${formatDuration(Math.max(0, Date.now() - started))})`;
  }

  return 'n/a';
}

function findingSeverityCounts(review: ReviewResponse): Record<ReviewSeverity, number> {
  if (review.summary?.findingCounts) {
    return {
      critical: review.summary.findingCounts.critical ?? 0,
      high: review.summary.findingCounts.high ?? 0,
      medium: review.summary.findingCounts.medium ?? 0,
      low: review.summary.findingCounts.low ?? 0,
      info: review.summary.findingCounts.info ?? 0,
    };
  }

  const counts: Record<ReviewSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const finding of review.findings) {
    counts[finding.severity] += 1;
  }

  return counts;
}

function buildTimeline(review: ReviewResponse): TimelinePhase[] {
  const created = toTimestamp(review.createdAt);
  const started = toTimestamp(review.startedAt);
  const finished = toTimestamp(review.finishedAt);
  const updated = toTimestamp(review.updatedAt);
  const now = Date.now();
  const terminal = review.status === 'succeeded' || review.status === 'failed' || review.status === 'cancelled';

  const contextDuration =
    started !== null
      ? safeDuration(created, started)
      : !terminal && created !== null
        ? Math.max(0, now - created)
        : null;

  const analysisDuration =
    finished !== null
      ? safeDuration(started, finished)
      : started !== null
        ? Math.max(0, now - started)
        : null;

  const finalizationDuration =
    finished !== null && updated !== null && updated >= finished
      ? updated - finished
      : terminal && finished !== null
        ? 0
        : null;

  return [
    {
      key: 'context',
      label: 'Context assembly',
      state: started !== null || terminal ? 'completed' : 'active',
      durationMs: contextDuration,
      detail:
        started !== null
          ? `Started at ${dateTimeLabel(review.startedAt)}`
          : terminal
            ? 'No start timestamp available.'
            : 'Preparing context inputs.',
    },
    {
      key: 'analysis',
      label: 'Analysis',
      state: finished !== null || terminal ? 'completed' : started !== null ? 'active' : 'pending',
      durationMs: analysisDuration,
      detail:
        finished !== null
          ? `Finished at ${dateTimeLabel(review.finishedAt)}`
          : started !== null
            ? 'Analysis in progress.'
            : 'Waiting for execution.',
    },
    {
      key: 'finalization',
      label: 'Finalization',
      state: terminal ? 'completed' : finished !== null ? 'active' : 'pending',
      durationMs: finalizationDuration,
      detail: terminal ? `Last updated ${dateTimeLabel(review.updatedAt)}` : 'Pending final output.',
    },
  ];
}

function FindingCard(props: {
  finding: ReviewFinding;
  index: number;
  onCopyFinding: (item: ReviewFinding) => void;
}): JSX.Element {
  const { finding, index, onCopyFinding } = props;
  const locationsText = findingLocationsText(finding);

  return (
    <article
      className="report-finding-enter space-y-2 rounded-sm border border-border/60 bg-card/85 px-3 py-2.5"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]',
            severityColor(finding.severity)
          )}
        >
          {finding.severity}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{finding.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
              {finding.category}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
              {`pass ${finding.passType}`}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{locationsText}</span>
          </div>
        </div>
        <button
          type="button"
          className="report-copy-btn shrink-0 text-xs"
          onClick={() => onCopyFinding(finding)}
        >
          Copy
        </button>
      </div>

      <div className="rounded-sm border border-border/50 bg-accent/20 px-2.5 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Suggested fix</p>
        <p className="text-sm leading-relaxed text-foreground/90">{finding.suggestedFix?.trim() || 'not provided'}</p>
      </div>
    </article>
  );
}

function ActivityLog({ entries, isLive }: { entries: ActivityLogEntry[]; isLive: boolean }): JSX.Element {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logEndRef.current;
    if (!node || typeof node.scrollIntoView !== 'function') {
      return;
    }
    try {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      // Non-fatal browser/test environment scroll failures should not break the page.
    }
  }, [entries.length]);

  if (entries.length === 0 && !isLive) {
    return <></>;
  }

  return (
    <div className="overflow-hidden rounded-sm border border-slate-700 bg-[#0b1120] text-slate-100 shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-[#050a16] px-3 py-2">
        <div className="flex items-center gap-2">
          {isLive && <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />}
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
            {isLive ? 'Live event stream' : 'Event history'}
          </span>
        </div>
        <span className="font-mono text-[11px] text-slate-500">{entries.length} event{entries.length === 1 ? '' : 's'}</span>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2.5">
        {entries.length === 0 ? (
          <div className="rounded-sm border border-dashed border-slate-700 bg-[#0f172a] px-3 py-4 font-mono text-sm text-slate-300">
            Waiting for events...
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  'report-log-entry grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-sm border px-3 py-2 font-mono',
                  isLive && entry.id === entries[entries.length - 1]?.id
                    ? 'border-emerald-500/35 bg-[#132238]'
                    : 'border-slate-800 bg-[#0f172a]'
                )}
              >
                <span className="text-[11px] text-slate-500 tabular-nums">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-100">{entry.label}</p>
                  {entry.detail && <p className="mt-0.5 text-xs text-slate-400">{entry.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

export function ReportPage(): JSX.Element {
  const { reviewId, repo, branch } = useParams<{ reviewId: string; repo: string; branch: string }>();
  const hasBranchContext = Boolean(repo && branch);

  const [state, setState] = useState<LoadState>('loading');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [recoveringReview, setRecoveringReview] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [showReviewedFiles, setShowReviewedFiles] = useState(false);
  const seenEventIds = useRef(new Set<string>());
  const fallbackEventOrdinal = useRef(0);

  const isLive = review ? LIVE_STREAM_STATUSES.has(review.status) : false;

  useEffect(() => {
    seenEventIds.current.clear();
    fallbackEventOrdinal.current = 0;
    setActivityLog([]);
    setShowReviewedFiles(false);
    setRecoveryError(null);
    setRecoveringReview(false);
  }, [reviewId]);

  useEffect(() => {
    if (!reviewId) {
      setState('error');
      setErrorMessage('Missing review id in URL.');
      return;
    }

    let cancelled = false;
    const backgroundRefresh = state === 'loaded' && refreshCycle > 0;
    if (!backgroundRefresh) {
      setState('loading');
    }

    fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status})`);
        }

        const data = parseGetReviewResponse((await response.json()) as GetReviewResponse);

        if (!cancelled) {
          setReview(data.review);
          setState('loaded');
          setErrorMessage('');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState('error');
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reviewId, refreshCycle]);

  useEffect(() => {
    if (state !== 'loaded' || !review) {
      return;
    }
    if (!LIVE_STREAM_STATUSES.has(review.status)) {
      return;
    }

    if (typeof EventSource === 'undefined') {
      const timer = window.setTimeout(() => setRefreshCycle((value) => value + 1), 3000);
      return () => {
        window.clearTimeout(timer);
      };
    }

    const eventsUrl = `${API_BASE}/api/reviews/${encodeURIComponent(review.id)}/events`;
    const stream = new EventSource(eventsUrl);

    const onMessage = (event: MessageEvent<string>) => {
      let eventType: string | null = null;
      let eventStatus: ReviewResponse['status'] | null = null;
      let eventData: Record<string, unknown> = {};

      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        eventType = typeof payload.type === 'string' ? payload.type : null;
        const rawStatus = typeof payload.status === 'string' ? payload.status : null;
        eventStatus = rawStatus && VALID_STATUSES.has(rawStatus as ReviewResponse['status'])
          ? (rawStatus as ReviewResponse['status'])
          : null;
        eventData = payload;
      } catch {
      }

      if (eventType === 'heartbeat') {
        return;
      }

      if (eventType) {
        const eventSeq = typeof eventData.seq === 'number'
          ? `seq:${eventData.seq}`
          : typeof eventData.id === 'number'
            ? `id:${eventData.id}`
            : typeof eventData.createdAt === 'string'
              ? `at:${eventData.createdAt}`
              : null;
        const fallbackKey = `fallback:${eventType}:${fallbackEventOrdinal.current++}`;
        const dedupeSource = eventSeq ?? fallbackKey;
        const dedupeKey = `${eventType}-${dedupeSource}`;
        if (!seenEventIds.current.has(dedupeKey)) {
          seenEventIds.current.add(dedupeKey);
          const logEntry = eventToLogEntry(eventType, eventData);
          if (logEntry) {
            setActivityLog((prev) => [...prev, logEntry]);
          }
        }
      }

      const derivedStatus = eventType ? statusFromReviewEventType(eventType) : null;
      const nextStatus = eventStatus ?? derivedStatus;

      if (nextStatus) {
        setReview((current) => {
          if (!current || current.status === nextStatus) {
            return current;
          }
          return { ...current, status: nextStatus };
        });
      }

      if (
        eventType === 'terminal' ||
        nextStatus === 'succeeded' ||
        nextStatus === 'failed' ||
        nextStatus === 'cancelled'
      ) {
        setRefreshCycle((value) => value + 1);
      }
    };

    const onError = () => {
      stream.close();
      window.setTimeout(() => {
        setRefreshCycle((value) => value + 1);
      }, 3000);
    };

    stream.addEventListener('message', onMessage);
    stream.addEventListener('error', onError);

    return () => {
      stream.removeEventListener('message', onMessage);
      stream.removeEventListener('error', onError);
      stream.close();
    };
  }, [review?.id, review?.status, state]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToastMessage(null);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toastMessage]);

  useEffect(() => {
    if (!showReviewedFiles) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowReviewedFiles(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showReviewedFiles]);

  const normalizedMarkdown = useMemo(() => normalizeMarkdownSummary(review?.markdownSummary ?? null), [review?.markdownSummary]);
  const markdownHtml = useMemo(() => renderedMarkdown(normalizedMarkdown), [normalizedMarkdown]);

  const groupedFindings = useMemo(() => {
    if (!review) {
      return [];
    }
    const grouped: Record<ReviewSeverity, ReviewFinding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: [],
    };

    for (const finding of review.findings) {
      grouped[finding.severity].push(finding);
    }

    let offset = 0;
    return FINDING_SEVERITY_ORDER.reduce<Array<{ severity: ReviewSeverity; findings: ReviewFinding[]; offset: number }>>((acc, severity) => {
      const findings = grouped[severity];
      if (findings.length === 0) {
        return acc;
      }
      acc.push({
        severity,
        findings,
        offset,
      });
      offset += findings.length;
      return acc;
    }, []);
  }, [review?.findings]);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await copyToClipboard(text);
      setToastMessage('Copied');
    } catch {
      setToastMessage('Copy failed');
    }
  }, []);

  const handleDownloadMarkdown = useCallback(() => {
    if (!reviewId || !review) {
      return;
    }
    downloadTextFile(`${reviewId}.md`, normalizedMarkdown, 'text/markdown');
  }, [reviewId, review, normalizedMarkdown]);

  const handleDownloadJson = useCallback(() => {
    if (!reviewId || !review) {
      return;
    }
    downloadTextFile(`${reviewId}.json`, JSON.stringify(review, null, 2), 'application/json');
  }, [reviewId, review]);

  const handleRecoverReview = useCallback(async () => {
    if (!reviewId) {
      return;
    }
    setRecoveringReview(true);
    setRecoveryError(null);
    try {
      const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/recover`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((body as { error?: string } | null)?.error ?? `Failed to recover review (${response.status})`);
      }
      const action = body && typeof body === 'object' && 'action' in body && typeof body.action === 'string' ? body.action : null;
      const parsed = parseGetReviewResponse(body);
      setReview(parsed.review);
      setToastMessage(action === 'failed' ? 'Review marked failed' : 'Recovery requested');
      setRefreshCycle((value) => value + 1);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringReview(false);
    }
  }, [reviewId]);

  const handleFailReview = useCallback(async () => {
    if (!reviewId) {
      return;
    }
    setRecoveringReview(true);
    setRecoveryError(null);
    try {
      const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/fail`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((body as { error?: string } | null)?.error ?? `Failed to fail review (${response.status})`);
      }
      const parsed = parseGetReviewResponse(body);
      setReview(parsed.review);
      setToastMessage(
        parsed.review.status === 'failed'
          ? 'Review marked failed'
          : `Review is already ${parsed.review.status}`
      );
      setRefreshCycle((value) => value + 1);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecoveringReview(false);
    }
  }, [reviewId]);

  if (state === 'loading') {
    return (
      <StatusLayout>
        <div className="policy-fade-up space-y-3 text-center">
          <p className="policy-clause-number">loading</p>
          <h1 className="policy-heading text-base text-foreground">Loading review</h1>
          <p className="text-sm font-light text-muted-foreground">Fetching review {reviewId ?? 'unknown'}...</p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
          </div>
        </div>
      </StatusLayout>
    );
  }

  if (state === 'error') {
    return (
      <StatusLayout>
        <div className="policy-fade-up max-w-lg space-y-3 text-center">
          <p className="policy-clause-number text-destructive/70">error</p>
          <h1 className="policy-heading text-base text-foreground">Unable to load review</h1>
          <p className="text-sm font-light text-muted-foreground">{errorMessage || 'Unknown error'}</p>
        </div>
      </StatusLayout>
    );
  }

  if (!review) {
    return (
      <StatusLayout>
        <div className="policy-fade-up space-y-3 text-center">
          <p className="policy-clause-number">empty</p>
          <h1 className="policy-heading text-base text-foreground">No review data</h1>
          <p className="text-sm font-light text-muted-foreground">The review payload is empty.</p>
        </div>
      </StatusLayout>
    );
  }

  const status = statusNarrative(review);
  const failureGuidance = reviewFailureGuidance(review);
  const cochangeBanner = cochangeStatusMessage(review);
  const contextResolutionBanner = contextResolutionMessage(review);
  const provenanceAdvisories = review.provenance.advisories ?? [];
  const modelSummary = review.summaryText?.trim() || null;
  const modelSignal =
    typeof review.furtherPassesLowYield === 'boolean'
      ? review.furtherPassesLowYield
      : review.provenance.furtherPassesLowYield?.value;
  const markdownUnavailable = normalizedMarkdown.length === 0;

  const recommendation = review.summary?.recommendation;
  const verdictTone = recommendationTone(recommendation);
  const severityCounts = findingSeverityCounts(review);
  const severityTotal =
    severityCounts.critical +
    severityCounts.high +
    severityCounts.medium +
    severityCounts.low;


  const timeline = buildTimeline(review);
  const contextStats = review.provenance.reviewContextStats;
  const tokenBudget = contextStats?.tokenBudget ?? null;
  const estimatedTokens = contextStats?.estimatedTokens ?? 0;
  const tokenUsageRatio = tokenBudget && tokenBudget > 0 ? Math.min(1, estimatedTokens / tokenBudget) : null;
  const reviewedFileSectionsList = reviewedFilesSections(review);
  const reviewedFilesAvailable = reviewedFileSectionsList.length > 0;
  const totalReviewedFiles =
    contextStats?.totalFilesIncluded ??
    reviewedFileSectionsList.reduce((total, section) => total + section.files.length, 0);
  const hasIntentDetails = Boolean(
    review.intent?.goal?.trim() ||
      (review.intent?.constraints.length ?? 0) > 0 ||
      (review.intent?.decisions.length ?? 0) > 0
  );
  const totalFindings = findingCount(review);
  const cochangeRelatedFileCount = review.provenance.coChange?.relatedFileCount ?? 0;
  const reviewCompletedWithoutFindings = review.status === 'succeeded' && totalFindings === 0;
  const showLiveActivityPanel = isLive;
  const latestActivityEntry = activityLog[activityLog.length - 1] ?? null;
  const verdictHeadline = primaryVerdictHeadline(review, totalFindings);
  const verdictDetail =
    review.status === 'succeeded' && modelSummary
      ? modelSummary
      : review.status === 'failed' && review.error?.message
        ? review.error.message
        : status.detail;

  return (
    <>
      <ReviewedFilesDialog
        open={showReviewedFiles}
        totalFiles={totalReviewedFiles}
        sections={reviewedFileSectionsList}
        onClose={() => setShowReviewedFiles(false)}
      />

      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-2 px-3 py-2 md:py-3">
      {toastMessage && <div className="report-toast">{toastMessage}</div>}

      {/* Breadcrumbs */}
      <nav className="policy-fade-up flex items-center gap-2 text-xs text-muted-foreground" style={{ animationDelay: '0ms' }}>
        <Link to="/" className="hover:text-foreground transition-colors">Studio Home</Link>
        {hasBranchContext && (
          <>
            <span className="text-muted-foreground/50">/</span>
            <Link
              to={`/branches/${encodeURIComponent(repo!)}/${encodeURIComponent(branch!)}`}
              className="hover:text-foreground transition-colors truncate max-w-[240px]"
            >
              {branch}
            </Link>
          </>
        )}
        <span className="text-muted-foreground/50">/</span>
        <span className="text-foreground font-medium font-mono truncate">{review.id}</span>
      </nav>

      <section className={cn('policy-fade-up rounded-sm border px-3 py-3', verdictTone.containerClass)} style={{ animationDelay: '40ms' }}>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Review {review.id}</p>
              <StatusPill status={review.status} />
              {hasBranchContext && <span className="text-xs text-muted-foreground">Branch {branch}</span>}
            </div>
            <h1 className={cn('policy-heading text-lg leading-tight', verdictTone.labelClass)}>{verdictHeadline}</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">{verdictDetail}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:max-w-[420px] md:justify-end">
            <button type="button" className="report-copy-btn" onClick={() => void handleCopy(normalizedMarkdown)} disabled={markdownUnavailable}>
              Copy full markdown
            </button>
            <button type="button" className="report-copy-btn" onClick={() => void handleCopy(JSON.stringify(review, null, 2))}>
              Copy full JSON
            </button>
            <button type="button" className="report-copy-btn" onClick={handleDownloadMarkdown} disabled={markdownUnavailable}>
              Download markdown
            </button>
            <button type="button" className="report-copy-btn" onClick={handleDownloadJson}>
              Download JSON
            </button>
          </div>
        </div>
      </section>

      {showLiveActivityPanel && (
        <section className="policy-fade-up space-y-2" style={{ animationDelay: '55ms' }}>
          <div className="overflow-hidden rounded-sm border border-slate-700 bg-[#020817] text-slate-100 shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-800 px-3 py-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Live review activity</p>
                </div>
                <h2 className="text-base font-semibold text-white">{status.title}</h2>
                <p className="text-sm text-slate-300">{status.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="rounded-full border-slate-700 bg-[#0f172a] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-slate-300">
                  {activityLog.length} event{activityLog.length === 1 ? '' : 's'}
                </Badge>
                {review.status === 'running' ? (
                  <button
                    type="button"
                    className="report-copy-btn border-slate-700 bg-[#0f172a] font-mono text-slate-100 hover:border-slate-500"
                    onClick={() => void handleFailReview()}
                    disabled={recoveringReview}
                  >
                    {recoveringReview ? 'Failing…' : 'Fail review'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="report-copy-btn border-slate-700 bg-[#0f172a] font-mono text-slate-100 hover:border-slate-500"
                    onClick={() => void handleRecoverReview()}
                    disabled={recoveringReview}
                  >
                    {recoveringReview ? 'Recovering…' : 'Recover review'}
                  </button>
                )}
              </div>
            </div>
            <div className="border-b border-slate-800 px-3 py-2">
              <p className="font-mono text-xs text-slate-300">
                {latestActivityEntry?.label ?? 'Waiting for the first live event'}
                {latestActivityEntry?.detail ? <span className="text-slate-500"> · {latestActivityEntry.detail}</span> : null}
              </p>
            </div>
            {(recoveryError || latestActivityEntry?.label === 'Sending to model') && (
              <div className="border-b border-slate-800 px-3 py-2">
                <p className="font-mono text-xs text-amber-200">
                  {recoveryError
                    ? recoveryError
                    : review.status === 'running'
                      ? 'If this stays on "Sending to model" longer than expected, mark the review failed so it no longer appears active. In-flight work may continue until the current attempt ends.'
                      : 'If this queued review is not making progress, recover it to request a clean retry.'}
                </p>
              </div>
            )}
            <ActivityLog entries={activityLog} isLive={isLive} />
          </div>
        </section>
      )}

      {failureGuidance && (
        <section className="policy-fade-up space-y-1 rounded-sm border border-red-200 bg-red-50/55 px-3 py-2" style={{ animationDelay: '60ms' }}>
          <h2 className="text-base font-semibold text-red-800">Failure guidance</h2>
          <p className="text-sm text-red-700">{failureGuidance.headline}</p>
          <p className="text-sm text-red-700">{failureGuidance.details}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-red-700">
            {failureGuidance.actions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {review.findings.length > 0 && (
        <section className="policy-fade-up flex flex-col gap-2.5" style={{ animationDelay: '68ms' }}>
          <div className="flex items-center justify-between">
            <h2 className="policy-heading text-sm text-foreground">Findings</h2>
            <button
              type="button"
              className="report-copy-btn text-xs"
              onClick={() => {
                const allFindings = review.findings.map((item) => buildFindingText(item)).join('\n\n---\n\n');
                void handleCopy(allFindings);
              }}
            >
              Copy all findings
            </button>
          </div>

          {groupedFindings.map((group) => (
            <div key={group.severity} className="space-y-1.5">
              <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-foreground">
                {group.severity} ({group.findings.length})
              </h3>
              <div className="flex flex-col gap-2">
                {group.findings.map((finding, index) => (
                  <FindingCard
                    key={`${finding.category}-${finding.passType}-${finding.severity}-${finding.description}-${finding.locations
                      .map((location) => `${location.filePath}:${location.startLine ?? 'null'}:${location.endLine ?? 'null'}`)
                      .join('|')}-${finding.suggestedFix}`}
                    finding={finding}
                    index={group.offset + index}
                    onCopyFinding={(item) => {
                      void handleCopy(buildFindingText(item));
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {reviewCompletedWithoutFindings && (
        <section className="policy-fade-up rounded-sm border border-emerald-200 bg-emerald-50/55 px-3 py-3" style={{ animationDelay: '72ms' }}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-emerald-900">Successful review</h2>
              <p className="text-sm text-emerald-900/90">
                Nimbus completed this review and did not identify actionable findings for this change.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:min-w-[420px]">
              <div className="rounded-sm border border-emerald-200 bg-white/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-emerald-800/70">Files reviewed</p>
                {reviewedFilesAvailable ? (
                  <button
                    type="button"
                    className="mt-1 flex items-center gap-2 text-left text-sm font-semibold text-emerald-950 underline decoration-emerald-300 underline-offset-2"
                    onClick={() => setShowReviewedFiles(true)}
                  >
                    {compactNumber(totalReviewedFiles)}
                    <span className="text-xs font-medium text-emerald-800/80">View files</span>
                  </button>
                ) : (
                  <p className="mt-1 text-sm font-semibold text-emerald-950">
                    {contextStats ? compactNumber(contextStats.totalFilesIncluded) : 'n/a'}
                  </p>
                )}
              </div>
              <div className="rounded-sm border border-emerald-200 bg-white/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-emerald-800/70">Sessions used</p>
                <p className="mt-1 text-sm font-semibold text-emerald-950">{compactNumber(review.provenance.sessionIds.length)}</p>
              </div>
              <div className="rounded-sm border border-emerald-200 bg-white/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-emerald-800/70">Related files</p>
                <p className="mt-1 text-sm font-semibold text-emerald-950">{compactNumber(cochangeRelatedFileCount)}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {!reviewCompletedWithoutFindings && review.findings.length === 0 && (
        <section className="policy-fade-up" style={{ animationDelay: '72ms' }}>
          <div className="card">
            <p>{findingsEmptyState(review)}</p>
          </div>
        </section>
      )}

      {!reviewCompletedWithoutFindings &&
        (modelSummary || hasIntentDetails || review.provenance.promptSummary || cochangeBanner || contextStats || reviewedFilesAvailable) && (
        <section className="policy-fade-up grid gap-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]" style={{ animationDelay: '80ms' }}>
          <div className="space-y-2">
            {modelSummary && (
              <div className="rounded-sm border border-border/60 bg-card/85 px-3 py-3">
                <h2 className="text-sm font-semibold text-foreground">Review summary</h2>
                <p className="mt-2 text-sm leading-6 text-foreground/85">{modelSummary}</p>
              </div>
            )}

            {hasIntentDetails && review.intent && (
              <div className="rounded-sm border border-border/60 bg-card/85 px-3 py-3">
                <h2 className="text-sm font-semibold text-foreground">Intent</h2>
                <div className="mt-2 space-y-2 text-sm">
                  {review.intent.goal?.trim() && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Goal</p>
                      <p className="mt-1 text-foreground">{review.intent.goal.trim()}</p>
                    </div>
                  )}
                  {review.intent.constraints.length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Constraints</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground">
                        {review.intent.constraints.map((constraint) => (
                          <li key={constraint}>{constraint}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {review.intent.decisions.length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Decisions</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground">
                        {review.intent.decisions.map((decision) => (
                          <li key={decision}>{decision}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="rounded-sm border border-border/60 bg-card/85 px-3 py-3">
              <h2 className="text-sm font-semibold text-foreground">Review scope</h2>
              {contextStats && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Files reviewed</p>
                    {reviewedFilesAvailable ? (
                      <button
                        type="button"
                        className="mt-1 text-left text-sm font-semibold text-foreground underline decoration-border underline-offset-2"
                        onClick={() => setShowReviewedFiles(true)}
                      >
                        {compactNumber(totalReviewedFiles)}
                      </button>
                    ) : (
                      <p className="mt-1 text-sm font-semibold text-foreground">{compactNumber(contextStats.totalFilesIncluded)}</p>
                    )}
                  </div>
                  <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Estimated tokens</p>
                    <p className="mt-1 text-sm font-semibold text-foreground">{compactNumber(estimatedTokens)}</p>
                  </div>
                </div>
              )}
              <dl className="mt-2 grid gap-2">
                {review.provenance.promptSummary && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Context summary</dt>
                    <dd className="mt-1 text-sm text-foreground">{review.provenance.promptSummary}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Session ids</dt>
                  <dd className="mt-1 text-sm text-foreground">
                    {review.provenance.sessionIds.length > 0 ? review.provenance.sessionIds.join(', ') : 'none'}
                  </dd>
                </div>
                {contextStats && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Context size</dt>
                    <dd className="mt-1 text-sm text-foreground">
                      {compactNumber(contextStats.totalFilesIncluded)} files · {compactNumber(contextStats.totalBytesIncluded)} bytes · {compactNumber(estimatedTokens)} estimated tokens
                    </dd>
                  </div>
                )}
                {reviewedFilesAvailable && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Reviewed file groups</dt>
                    <dd className="mt-1 text-sm text-foreground">
                      {reviewedFileSectionsList.map((section) => `${section.label}: ${compactNumber(section.files.length)}`).join(' · ')}
                    </dd>
                  </div>
                )}
                {cochangeBanner && (
                  <div>
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Co-change context</dt>
                    <dd className="mt-1 text-sm text-foreground">{cochangeBanner}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </section>
      )}

      <section className="policy-fade-up" style={{ animationDelay: '100ms' }}>
        <details className="card">
          <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">Review details</summary>
          <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
            <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">{status.title}</h3>
              <p className="text-sm text-muted-foreground">{status.detail}</p>
            </div>

            {reviewCompletedWithoutFindings && modelSummary && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Review summary</h3>
                <p className="text-sm text-foreground/85">{modelSummary}</p>
              </div>
            )}

            {reviewCompletedWithoutFindings && hasIntentDetails && review.intent && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Intent</h3>
                <div className="mt-2 space-y-2 text-sm">
                  {review.intent.goal?.trim() && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Goal</p>
                      <p className="mt-1 text-foreground">{review.intent.goal.trim()}</p>
                    </div>
                  )}
                  {review.intent.constraints.length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Constraints</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground">
                        {review.intent.constraints.map((constraint) => (
                          <li key={constraint}>{constraint}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {review.intent.decisions.length > 0 && (
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Decisions</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground">
                        {review.intent.decisions.map((decision) => (
                          <li key={decision}>{decision}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            {reviewCompletedWithoutFindings && (review.provenance.promptSummary || cochangeBanner || contextStats || reviewedFilesAvailable) && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Review scope</h3>
                {contextStats && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="rounded-sm border border-border/60 bg-background/70 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Files reviewed</p>
                      {reviewedFilesAvailable ? (
                        <button
                          type="button"
                          className="mt-1 text-left text-sm font-semibold text-foreground underline decoration-border underline-offset-2"
                          onClick={() => setShowReviewedFiles(true)}
                        >
                          {compactNumber(totalReviewedFiles)}
                        </button>
                      ) : (
                        <p className="mt-1 text-sm font-semibold text-foreground">{compactNumber(contextStats.totalFilesIncluded)}</p>
                      )}
                    </div>
                    <div className="rounded-sm border border-border/60 bg-background/70 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Estimated tokens</p>
                      <p className="mt-1 text-sm font-semibold text-foreground">{compactNumber(estimatedTokens)}</p>
                    </div>
                  </div>
                )}
                <dl className="mt-2 grid gap-2">
                  {review.provenance.promptSummary && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Context summary</dt>
                      <dd className="mt-1 text-sm text-foreground">{review.provenance.promptSummary}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Session ids</dt>
                    <dd className="mt-1 text-sm text-foreground">
                      {review.provenance.sessionIds.length > 0 ? review.provenance.sessionIds.join(', ') : 'none'}
                    </dd>
                  </div>
                  {contextStats && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Context size</dt>
                      <dd className="mt-1 text-sm text-foreground">
                        {compactNumber(contextStats.totalFilesIncluded)} files · {compactNumber(contextStats.totalBytesIncluded)} bytes · {compactNumber(estimatedTokens)} estimated tokens
                      </dd>
                    </div>
                  )}
                  {reviewedFilesAvailable && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Reviewed file groups</dt>
                      <dd className="mt-1 text-sm text-foreground">
                        {reviewedFileSectionsList.map((section) => `${section.label}: ${compactNumber(section.files.length)}`).join(' · ')}
                      </dd>
                    </div>
                  )}
                  {cochangeBanner && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Co-change context</dt>
                      <dd className="mt-1 text-sm text-foreground">{cochangeBanner}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Risk</p>
                <p className="mt-1">
                  <span
                    className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]',
                      riskLevelClass(review.summary?.riskLevel)
                    )}
                  >
                    {review.summary?.riskLevel ?? 'unknown'}
                  </span>
                </p>
              </div>
              <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Findings</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{findingCount(review)}</p>
              </div>
              <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Time to complete</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{reviewDurationLabel(review)}</p>
              </div>
              <div className="rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Updated</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{dateTimeLabel(review.updatedAt)}</p>
              </div>
            </div>

            {severityTotal > 0 && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Finding distribution</h3>
                <div className="space-y-1.5">
                  <div className="h-2 overflow-hidden rounded-full border border-border/50 bg-muted/40">
                    <div className="flex h-full w-full">
                      {severityCounts.critical > 0 ? (
                        <div className={severityBarColor('critical')} style={{ width: `${(severityCounts.critical / severityTotal) * 100}%` }} />
                      ) : null}
                      {severityCounts.high > 0 ? (
                        <div className={severityBarColor('high')} style={{ width: `${(severityCounts.high / severityTotal) * 100}%` }} />
                      ) : null}
                      {severityCounts.medium > 0 ? (
                        <div className={severityBarColor('medium')} style={{ width: `${(severityCounts.medium / severityTotal) * 100}%` }} />
                      ) : null}
                      {severityCounts.low > 0 ? (
                        <div className={severityBarColor('low')} style={{ width: `${(severityCounts.low / severityTotal) * 100}%` }} />
                      ) : null}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-semibold text-red-700">{severityCounts.critical} critical</span>
                    {' · '}
                    <span className="font-semibold text-orange-700">{severityCounts.high} high</span>
                    {' · '}
                    <span className="font-semibold text-amber-700">{severityCounts.medium} medium</span>
                    {' · '}
                    <span className="font-semibold text-sky-700">{severityCounts.low} low</span>
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">Review timeline</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                {timeline.map((phase) => (
                  <li key={phase.key}>
                    <span className="font-medium">{phase.label}:</span> {phase.state} · {formatDuration(phase.durationMs)} · {phase.detail}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">Token budget</h3>
              {contextStats ? (
                <>
                  <p className="text-sm text-foreground">
                    {tokenBudget && tokenBudget > 0 ? `${estimatedTokens} / ${tokenBudget}` : `${estimatedTokens} estimated tokens`}
                  </p>
                  {tokenUsageRatio !== null ? (
                    <div className="h-2 overflow-hidden rounded-full border border-border/50 bg-muted/40">
                      <div
                        className={cn('h-full', tokenUsageRatio > 0.9 ? 'bg-amber-500' : 'bg-emerald-500')}
                        style={{ width: `${tokenUsageRatio * 100}%` }}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Token budget usage not available.</p>
              )}
            </div>

            <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">Context</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                <li>
                  Session ids: {review.provenance.sessionIds.length > 0 ? review.provenance.sessionIds.join(', ') : 'none'}
                </li>
                {cochangeBanner ? <li>{cochangeBanner}</li> : null}
              </ul>
            </div>

            {review.evidence.length > 0 && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">Review receipts</h3>
                  <p className="text-xs text-muted-foreground">{review.evidence.length} item{review.evidence.length === 1 ? '' : 's'}</p>
                </div>
                <div className="mt-2 grid gap-2">
                  {review.evidence.map((item) => (
                    <div key={item.id} className="rounded-sm border border-border/60 bg-background/70 px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{item.label}</p>
                          <p className="text-xs text-muted-foreground">{item.type}</p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]',
                            evidenceStatusClass(item.status)
                          )}
                        >
                          {item.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {review.approvedPolicy && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Approved policy</h3>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                  <li>Goal: {review.approvedPolicy.goal?.trim() || 'No goal provided.'}</li>
                  <li>
                    Prohibitions: {review.approvedPolicy.prohibitions.length > 0 ? review.approvedPolicy.prohibitions.join('; ') : 'none'}
                  </li>
                  <li>
                    Preferences: {review.approvedPolicy.constraints.length > 0 ? review.approvedPolicy.constraints.join('; ') : 'none'}
                  </li>
                </ul>
              </div>
            )}

            <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
              <h3 className="text-sm font-semibold text-foreground">Model output</h3>
              <dl className="summary-grid">
                <div>
                  <dt>Output schema</dt>
                  <dd>{review.provenance.outputSchemaVersion ?? 'unknown'}</dd>
                </div>
                <div>
                  <dt>Pass architecture</dt>
                  <dd>{review.provenance.passArchitecture ?? 'unknown'}</dd>
                </div>
                <div>
                  <dt>Further passes low yield</dt>
                  <dd>{typeof modelSignal === 'boolean' ? (modelSignal ? 'yes' : 'no') : 'unknown'}</dd>
                </div>
              </dl>
              <p className="text-sm text-muted-foreground">{modelSummary ?? 'Model summary not available yet.'}</p>
            </div>

            {contextResolutionBanner && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Context fallback used</h3>
                <p className="text-sm text-muted-foreground">{contextResolutionBanner}</p>
                {review.provenance.contextResolution && (
                  <dl className="summary-grid mt-1">
                    <div>
                      <dt>Original checkpoint</dt>
                      <dd>{review.provenance.contextResolution.originalCheckpointId}</dd>
                    </div>
                    <div>
                      <dt>Resolved checkpoint</dt>
                      <dd>{review.provenance.contextResolution.resolvedCheckpointId}</dd>
                    </div>
                  </dl>
                )}
              </div>
            )}

            {provenanceAdvisories.length > 0 && (
              <div className="space-y-1 rounded-sm border border-border/60 bg-card/70 px-3 py-2">
                <h3 className="text-sm font-semibold text-foreground">Advisories</h3>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                  {provenanceAdvisories.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {!isLive && activityLog.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-foreground">Activity log</h3>
                <ActivityLog entries={activityLog} isLive={isLive} />
              </div>
            )}
          </div>
        </details>
      </section>

      <section className="policy-fade-up" style={{ animationDelay: '120ms' }}>
        <details className="card">
          <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">Markdown summary</summary>
          <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                <button type="button" className="report-copy-btn text-xs" onClick={() => void handleCopy(normalizedMarkdown)} disabled={markdownUnavailable}>
                  Copy markdown
                </button>
                <button type="button" className="report-copy-btn text-xs" onClick={handleDownloadMarkdown} disabled={markdownUnavailable}>
                  Download .md
                </button>
              </div>
            </div>
            <article className="card report-markdown" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          </div>
        </details>
      </section>

      <section className="policy-fade-up section-block" style={{ animationDelay: '200ms' }}>
        <details className="card raw-json">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(review, null, 2)}</pre>
        </details>
      </section>
      </main>
    </>
  );
}
