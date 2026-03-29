import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyToClipboard } from '../lib/clipboard';
import { downloadTextFile } from '../lib/download';
import { StatusPill } from './ui/StatusPill';
import {
  buildFindingText,
  dateTimeLabel,
  findingCount,
  findingLocationsText,
  parseGetReviewResponse,
  recommendationLabel,
  reviewFailureGuidance,
  statusNarrative,
} from '../lib/review';
import type { GetReviewResponse, ReviewFinding, ReviewResponse, ReviewSeverity } from '../types';
import { cn } from '../lib/utils';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';
type TimelinePhaseState = 'completed' | 'active' | 'pending';

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
  } else if (eventType === 'review_finding_emitted' && typeof data.description === 'string') {
    detail = data.description;
  } else if (eventType === 'review_context_changed_files_collected' && typeof data.changedFileCount === 'number') {
    detail = `${data.changedFileCount} files`;
  } else if (eventType === 'review_analysis_agent_started' && typeof data.model === 'string') {
    detail = data.model;
  } else if (eventType === 'review_context_budget_checked' && typeof data.estimatedTokens === 'number' && typeof data.tokenBudget === 'number') {
    detail = `${data.estimatedTokens.toLocaleString()} / ${data.tokenBudget.toLocaleString()} tokens`;
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

function StatusLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-5 py-8">
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
    <details
      className="report-finding-enter overflow-hidden rounded-md border border-border/60 bg-card/80"
      style={{ animationDelay: `${index * 45}ms` }}
    >
      <summary className="cursor-pointer list-none px-3 py-2.5">
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
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{locationsText}</p>
          </div>
          <button
            type="button"
            className="report-copy-btn shrink-0 text-xs"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopyFinding(finding);
            }}
          >
            Copy
          </button>
        </div>
      </summary>

      <div className="space-y-2 border-t border-border/40 bg-accent/20 px-3 py-2.5">
        <div className="flex flex-wrap gap-1">
          <span className="inline-flex items-center rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
            {finding.category}
          </span>
          <span className="inline-flex items-center rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
            {`pass ${finding.passType}`}
          </span>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Suggested fix</p>
          <p className="text-sm leading-relaxed text-foreground/90">{finding.suggestedFix?.trim() || 'not provided'}</p>
        </div>
      </div>
    </details>
  );
}

function ActivityLog({ entries, isLive }: { entries: ActivityLogEntry[]; isLive: boolean }): JSX.Element {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [entries.length]);

  if (entries.length === 0 && !isLive) {
    return <></>;
  }

  return (
    <div className="border border-border/50 bg-[hsl(240_10%_8%)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
        {isLive && <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />}
        <span className="text-xs font-medium text-white/50 uppercase tracking-widest">
          {isLive ? 'Live' : 'Event history'}
        </span>
      </div>
      <div className="max-h-48 overflow-y-auto font-mono text-xs leading-relaxed">
        {entries.length === 0 ? (
          <div className="px-3 py-3 text-white/30">Waiting for events...</div>
        ) : (
          <div className="divide-y divide-white/5">
            {entries.map((entry) => (
              <div key={entry.id} className="report-log-entry px-3 py-1.5 flex gap-3">
                <span className="text-white/25 shrink-0 tabular-nums">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="text-white/70">{entry.label}</span>
                {entry.detail && <span className="text-white/35 truncate">{entry.detail}</span>}
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
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [policyExpanded, setPolicyExpanded] = useState(true);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const seenEventIds = useRef(new Set<string>());

  const isLive = review?.status === 'queued' || review?.status === 'running' || review?.status === 'policy_approved';

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
    if (review.status !== 'queued' && review.status !== 'running' && review.status !== 'policy_approved') {
      return;
    }

    if (typeof EventSource === 'undefined') {
      const timer = window.setTimeout(() => {
        setRefreshCycle((value) => value + 1);
      }, 3000);
      return () => {
        window.clearTimeout(timer);
      };
    }

    const eventsUrl = `${API_BASE}/api/reviews/${encodeURIComponent(review.id)}/events`;
    const stream = new EventSource(eventsUrl);
    let errorRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (event: MessageEvent<string>) => {
      let eventType: string | null = null;
      let eventStatus: ReviewResponse['status'] | null = null;
      let eventData: Record<string, unknown> = {};

      try {
        const payload = JSON.parse(event.data) as Record<string, unknown>;
        eventType = typeof payload.type === 'string' ? payload.type : null;
        const rawStatus = typeof payload.status === 'string' ? payload.status : null;
        eventStatus =
          rawStatus === 'policy_pending' || rawStatus === 'policy_ready' || rawStatus === 'policy_approved' ||
          rawStatus === 'queued' || rawStatus === 'running' ||
          rawStatus === 'succeeded' || rawStatus === 'failed' || rawStatus === 'cancelled'
            ? (rawStatus as ReviewResponse['status'])
            : null;
        eventData = payload;
      } catch {
      }

      if (eventType === 'heartbeat') {
        return;
      }

      if (eventType) {
        const dedupeKey = `${eventType}-${JSON.stringify(eventData.description ?? eventData.step ?? '')}`;
        if (!seenEventIds.current.has(dedupeKey)) {
          seenEventIds.current.add(dedupeKey);
          const logEntry = eventToLogEntry(eventType, eventData);
          if (logEntry) {
            setActivityLog((prev) => [...prev, logEntry]);
          }
        }
      }

      if (eventStatus) {
        setReview((current) => {
          if (!current || current.status === eventStatus) {
            return current;
          }
          return { ...current, status: eventStatus };
        });
      }

      if (
        eventType === 'terminal' ||
        eventStatus === 'succeeded' ||
        eventStatus === 'failed' ||
        eventStatus === 'cancelled'
      ) {
        setRefreshCycle((value) => value + 1);
      }
    };

    const onError = () => {
      stream.close();
      errorRetryTimer = setTimeout(() => {
        setRefreshCycle((value) => value + 1);
      }, 3000);
    };

    stream.addEventListener('message', onMessage);
    stream.addEventListener('error', onError);

    return () => {
      stream.removeEventListener('message', onMessage);
      stream.removeEventListener('error', onError);
      stream.close();
      if (errorRetryTimer !== null) {
        clearTimeout(errorRetryTimer);
      }
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

  if (state === 'loading') {
    return (
      <StatusLayout>
        <div className="policy-fade-up space-y-3 text-center">
          <p className="policy-clause-number">loading</p>
          <h1 className="policy-heading text-xl text-foreground">Loading review</h1>
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
          <h1 className="policy-heading text-xl text-foreground">Unable to load review</h1>
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
          <h1 className="policy-heading text-xl text-foreground">No review data</h1>
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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:py-5">
      {toastMessage && <div className="report-toast">{toastMessage}</div>}

      {/* Breadcrumbs */}
      <nav className="policy-fade-up flex items-center gap-2 text-xs text-muted-foreground" style={{ animationDelay: '0ms' }}>
        <Link to="/" className="hover:text-foreground transition-colors">Branches</Link>
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

      {/* Activity log */}
      {(isLive || activityLog.length > 0) && (
        <section className="policy-fade-up" style={{ animationDelay: '20ms' }}>
          <ActivityLog entries={activityLog} isLive={isLive} />
        </section>
      )}

      <section className={cn('policy-fade-up card space-y-3 border', verdictTone.containerClass)} style={{ animationDelay: '40ms' }}>
        <div className="summary-header">
          <h1 className="policy-heading text-xl text-foreground">Review {review.id}</h1>
          <StatusPill status={review.status} />
        </div>

        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Recommendation</p>
          <p className={cn('policy-heading text-2xl leading-tight capitalize', verdictTone.labelClass)}>
            {recommendationLabel(recommendation)}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-border/70 bg-card/65 px-2.5 py-2">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Risk</dt>
            <dd className="mt-1">
              <span
                className={cn(
                  'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.08em]',
                  riskLevelClass(review.summary?.riskLevel)
                )}
              >
                {review.summary?.riskLevel ?? 'unknown'}
              </span>
            </dd>
          </div>
          <div className="rounded-md border border-border/70 bg-card/65 px-2.5 py-2">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Findings</dt>
            <dd className="mt-1 text-base font-semibold text-foreground">{findingCount(review)}</dd>
          </div>
          <div className="rounded-md border border-border/70 bg-card/65 px-2.5 py-2">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Time to complete</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground">{reviewDurationLabel(review)}</dd>
          </div>
          <div className="rounded-md border border-border/70 bg-card/65 px-2.5 py-2">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Updated</dt>
            <dd className="mt-1 text-sm font-semibold text-foreground">{dateTimeLabel(review.updatedAt)}</dd>
          </div>
        </dl>

        <div className="space-y-1.5">
          <div className="h-2 overflow-hidden rounded-full border border-border/50 bg-muted/40">
            <div className="flex h-full w-full">
              {severityTotal > 0 ? (
                <>
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
                </>
              ) : (
                <div className="h-full w-full bg-muted" />
              )}
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

        <div className="button-row border-t border-border/70 pt-2">
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
      </section>

      <section className="policy-fade-up card status-card" style={{ animationDelay: '40ms' }}>
        <h2>{status.title}</h2>
        <p>{status.detail}</p>
      </section>

      {failureGuidance && (
        <section className="policy-fade-up space-y-1 rounded-lg border border-red-200 bg-red-50/55 px-4 py-3" style={{ animationDelay: '60ms' }}>
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

      {review.approvedPolicy && (
        <section className="policy-fade-up card space-y-2" style={{ animationDelay: '80ms' }}>
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setPolicyExpanded((value) => !value)}
          >
            <span className="policy-heading text-lg text-foreground">Approved policy</span>
            <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
              {policyExpanded ? 'Collapse' : 'Expand'}
            </span>
          </button>

          {policyExpanded ? (
            <div className="space-y-2 border-t border-border/70 pt-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Goal</p>
                <p className="text-sm text-foreground">{review.approvedPolicy.goal?.trim() || 'No goal provided.'}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Prohibitions</p>
                {review.approvedPolicy.prohibitions.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                    {review.approvedPolicy.prohibitions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">None</p>
                )}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Preferences</p>
                {review.approvedPolicy.constraints.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
                    {review.approvedPolicy.constraints.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">None</p>
                )}
              </div>
            </div>
          ) : null}
        </section>
      )}

      <section className="policy-fade-up card space-y-2" style={{ animationDelay: '100ms' }}>
        <h2 className="policy-heading text-lg text-foreground">Review timeline</h2>
        <ol className="space-y-2">
          {timeline.map((phase) => (
            <li key={phase.key} className="rounded-md border border-border/60 bg-card/70 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{phase.label}</span>
                <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]', phaseStateClass(phase.state))}>
                  {phase.state}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{phase.detail}</p>
              <p className="text-xs font-medium text-foreground">Duration: {formatDuration(phase.durationMs)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="policy-fade-up flex flex-col gap-2.5" style={{ animationDelay: '120ms' }}>
        <div className="flex items-center justify-between">
          <h2 className="policy-heading text-lg text-foreground">Findings</h2>
          {review.findings.length > 0 && (
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
          )}
        </div>

        {review.findings.length === 0 ? (
          <div className="card">
            <p>No findings were reported.</p>
          </div>
        ) : (
          groupedFindings.map((group) => (
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
          ))
        )}
      </section>

      <section className="policy-fade-up card space-y-2" style={{ animationDelay: '140ms' }}>
        <h2 className="policy-heading text-lg text-foreground">Provenance</h2>

        {contextStats ? (
          <div className="space-y-1.5 rounded-md border border-border/60 bg-card/70 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Token budget</p>
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Token budget usage not available.</p>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-border/60 bg-card/70 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Validation repair attempted</p>
            <p className="text-sm font-semibold text-foreground">
              {review.provenance.validation
                ? review.provenance.validation.repairAttempted
                  ? 'yes'
                  : 'no'
                : 'unknown'}
            </p>
          </div>
          <div className="rounded-md border border-border/60 bg-card/70 px-3 py-2">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Validation repair succeeded</p>
            <p className="text-sm font-semibold text-foreground">
              {review.provenance.validation
                ? review.provenance.validation.repairSucceeded
                  ? 'yes'
                  : 'no'
                : 'unknown'}
            </p>
          </div>
        </div>

        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          <li>
            Session ids: {review.provenance.sessionIds.length > 0 ? review.provenance.sessionIds.join(', ') : 'none'}
          </li>
          {cochangeBanner ? <li>{cochangeBanner}</li> : null}
          {review.provenance.promptSummary ? <li>{review.provenance.promptSummary}</li> : null}
        </ul>

        {contextResolutionBanner && (
          <div className="space-y-1 rounded-md border border-border/60 bg-card/70 px-3 py-2">
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
          <div className="space-y-1 rounded-md border border-border/60 bg-card/70 px-3 py-2">
            <h3 className="text-sm font-semibold text-foreground">Advisories</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
              {provenanceAdvisories.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="policy-fade-up section-block" style={{ animationDelay: '160ms' }}>
        <h2>Model output</h2>
        <article className="card">
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
          <p>{modelSummary ?? 'Model summary not available yet.'}</p>
        </article>
      </section>

      <section className="policy-fade-up section-block" style={{ animationDelay: '180ms' }}>
        <div className="flex items-center justify-between">
          <h2>Markdown summary</h2>
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
      </section>

      <section className="policy-fade-up section-block" style={{ animationDelay: '200ms' }}>
        <details className="card raw-json">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(review, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
