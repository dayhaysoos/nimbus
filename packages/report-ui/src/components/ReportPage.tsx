import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyToClipboard } from '../lib/clipboard';
import { downloadTextFile } from '../lib/download';
import {
  buildFindingText,
  dateTimeLabel,
  findingCount,
  parseGetReviewResponse,
  recommendationLabel,
  reviewFailureGuidance,
  statusNarrative,
} from '../lib/review';
import type { GetReviewResponse, ReviewFinding, ReviewResponse } from '../types';
import { cn } from '@/lib/utils';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';

const VALID_STATUSES: ReadonlySet<ReviewResponse['status']> = new Set([
  'policy_pending', 'policy_ready', 'policy_approved',
  'queued', 'running', 'succeeded', 'failed', 'cancelled',
]);

const LIVE_STREAM_STATUSES: ReadonlySet<ReviewResponse['status']> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

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

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical': return 'text-red-700 bg-red-50 border-red-200';
    case 'high': return 'text-orange-700 bg-orange-50 border-orange-200';
    case 'medium': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'low': return 'text-sky-700 bg-sky-50 border-sky-200';
    case 'info': return 'text-slate-600 bg-slate-50 border-slate-200';
    default: return 'text-slate-600 bg-slate-50 border-slate-200';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'succeeded': return 'text-emerald-700 bg-emerald-50 border-emerald-300';
    case 'running':
    case 'queued':
    case 'policy_approved': return 'text-amber-700 bg-amber-50 border-amber-300';
    case 'failed':
    case 'cancelled': return 'text-red-700 bg-red-50 border-red-300';
    default: return 'text-muted-foreground bg-muted border-border';
  }
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
          return { ...state, skippingEvidence: true };
        }
        if (state.skippingEvidence && /^##\s+/.test(line)) {
          return { lines: [...state.lines, line], skippingEvidence: false };
        }
        if (state.skippingEvidence) {
          return state;
        }
        return { ...state, lines: [...state.lines, line] };
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
  if (!coChange) return null;
  if (coChange.coChangeSkipped) {
    const reason = coChange.coChangeSkipReason === 'missing_github_token'
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
  if (!contextResolution || contextResolution.contextResolution !== 'branch_fallback') return null;
  const commitLabel = contextResolution.resolvedCommitMessage?.trim()
    ? `${contextResolution.resolvedCommitSha.slice(0, 7)} (${contextResolution.resolvedCommitMessage.trim()})`
    : contextResolution.resolvedCommitSha.slice(0, 7);
  return `Session context used branch fallback: checkpoint ${contextResolution.originalCheckpointId} had no readable context, so this review used checkpoint ${contextResolution.resolvedCheckpointId} from commit ${commitLabel}.`;
}

/* ── Components ── */

function FindingCard({
  finding,
  index,
  onCopy,
}: {
  finding: ReviewFinding;
  index: number;
  onCopy: (text: string) => void;
}): JSX.Element {
  const locationsText = finding.locations.length
    ? finding.locations
        .map((loc) =>
          loc.startLine !== null && loc.endLine !== null
            ? `${loc.filePath}:${loc.startLine}-${loc.endLine}`
            : loc.filePath
        )
        .join(', ')
    : 'none provided';

  return (
    <article
      className="report-finding-enter border border-border/50 bg-card/80 rounded-lg overflow-hidden"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={cn(
          'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider border shrink-0 mt-0.5',
          severityColor(finding.severity),
        )}>
          {finding.severity}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-snug">{finding.description}</p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tracking-wide">
              {finding.category}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tracking-wide">
              {finding.passType}
            </span>
            <span className="text-xs text-muted-foreground/60 font-mono">{locationsText}</span>
          </div>
        </div>
        <button
          type="button"
          className="report-copy-btn text-xs shrink-0"
          onClick={() => onCopy(buildFindingText(finding))}
          title="Copy finding with suggested fix"
        >
          Copy
        </button>
      </div>

      {/* Suggested fix */}
      {finding.suggestedFix?.trim() && (
        <div className="px-4 py-2.5 border-t border-border/30 bg-accent/20">
          <p className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider mb-0.5">Suggested fix</p>
          <p className="text-sm text-foreground/90 leading-relaxed">{finding.suggestedFix}</p>
        </div>
      )}
    </article>
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
          {isLive ? 'Live' : 'Activity log'}
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
                {entry.detail && (
                  <span className="text-white/35 truncate">{entry.detail}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

/* ── Main page ── */

export function ReportPage(): JSX.Element {
  const { reviewId } = useParams<{ reviewId: string }>();

  const [state, setState] = useState<LoadState>('loading');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const seenEventIds = useRef(new Set<string>());

  const isLive = review ? LIVE_STREAM_STATUSES.has(review.status) : false;

  useEffect(() => {
    seenEventIds.current.clear();
    setActivityLog([]);
  }, [reviewId]);

  // Fetch review data
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

    return () => { cancelled = true; };
  }, [reviewId, refreshCycle]);

  // SSE stream
  useEffect(() => {
    if (state !== 'loaded' || !review) return;
    if (!LIVE_STREAM_STATUSES.has(review.status)) return;

    if (typeof EventSource === 'undefined') {
      const timer = window.setTimeout(() => setRefreshCycle((v) => v + 1), 3000);
      return () => window.clearTimeout(timer);
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

      if (eventType === 'heartbeat') return;

      // Add to activity log (dedupe by event type + timestamp window)
      if (eventType) {
        const eventSeq = typeof eventData.seq === 'number'
          ? `seq:${eventData.seq}`
          : typeof eventData.id === 'number'
            ? `id:${eventData.id}`
            : typeof eventData.createdAt === 'string'
              ? `at:${eventData.createdAt}`
              : `sig:${JSON.stringify(eventData.description ?? eventData.step ?? '')}`;
        const dedupeKey = `${eventType}-${eventSeq}`;
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
          if (!current || current.status === nextStatus) return current;
          return { ...current, status: nextStatus };
        });
      }

      if (eventType === 'terminal' || nextStatus === 'succeeded' || nextStatus === 'failed' || nextStatus === 'cancelled') {
        setRefreshCycle((v) => v + 1);
      }
    };

    const onError = () => {
      stream.close();
      window.setTimeout(() => setRefreshCycle((v) => v + 1), 3000);
    };

    stream.addEventListener('message', onMessage);
    stream.addEventListener('error', onError);
    return () => {
      stream.removeEventListener('message', onMessage);
      stream.removeEventListener('error', onError);
      stream.close();
    };
  }, [review?.id, review?.status, state]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  const normalizedMarkdown = useMemo(() => normalizeMarkdownSummary(review?.markdownSummary ?? null), [review?.markdownSummary]);
  const markdownHtml = useMemo(() => renderedMarkdown(normalizedMarkdown), [normalizedMarkdown]);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await copyToClipboard(text);
      setToastMessage('Copied');
    } catch {
      setToastMessage('Copy failed');
    }
  }, []);

  const handleCopyAllFindings = useCallback(() => {
    if (!review) return;
    const allText = review.findings.map((f) => buildFindingText(f)).join('\n\n---\n\n');
    void handleCopy(allText);
  }, [review, handleCopy]);

  const handleDownloadMarkdown = useCallback(() => {
    if (!reviewId || !review) return;
    downloadTextFile(`${reviewId}.md`, normalizedMarkdown, 'text/markdown');
  }, [reviewId, review, normalizedMarkdown]);

  const handleDownloadJson = useCallback(() => {
    if (!reviewId || !review) return;
    downloadTextFile(`${reviewId}.json`, JSON.stringify(review, null, 2), 'application/json');
  }, [reviewId, review]);

  /* ── Loading ── */
  if (state === 'loading') {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-5 py-8">
        <div className="policy-fade-up text-center space-y-3">
          <p className="policy-clause-number">loading</p>
          <h1 className="policy-heading text-xl text-foreground">Fetching review</h1>
          <p className="text-sm text-muted-foreground font-light">{reviewId ?? 'unknown'}</p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
          </div>
        </div>
      </main>
    );
  }

  /* ── Error ── */
  if (state === 'error') {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-5 py-8">
        <div className="policy-fade-up text-center space-y-3 max-w-lg">
          <p className="policy-clause-number text-destructive/70">error</p>
          <h1 className="policy-heading text-xl text-foreground">Unable to load review</h1>
          <p className="text-sm text-muted-foreground font-light">{errorMessage || 'Unknown error'}</p>
        </div>
      </main>
    );
  }

  if (!review) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-5 py-8">
        <div className="policy-fade-up text-center space-y-3">
          <p className="policy-clause-number">empty</p>
          <h1 className="policy-heading text-xl text-foreground">No review data</h1>
          <p className="text-sm text-muted-foreground font-light">The review payload is empty.</p>
        </div>
      </main>
    );
  }

  const status = statusNarrative(review);
  const failureGuidance = reviewFailureGuidance(review);
  const cochangeBanner = cochangeStatusMessage(review);
  const contextResolutionBanner = contextResolutionMessage(review);
  const provenanceAdvisories = review.provenance.advisories ?? [];
  const markdownUnavailable = normalizedMarkdown.length === 0;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-4 md:py-6">
      {toastMessage && <div className="report-toast">{toastMessage}</div>}

      {/* Header */}
      <header className="policy-fade-up flex flex-col gap-2" style={{ animationDelay: '0ms' }}>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="policy-heading text-xl text-foreground tracking-tight shrink-0">
            Review
          </h1>
          <code className="text-xs text-muted-foreground font-mono bg-muted/50 px-2 py-0.5 rounded">{review.id}</code>
          <span className={cn(
            'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider border ml-auto',
            statusColor(review.status),
          )}>
            {isLive && <span className="h-1.5 w-1.5 rounded-full bg-current mr-1.5 animate-pulse" />}
            {review.status.replace('_', ' ')}
          </span>
        </div>
        <p className="text-sm text-muted-foreground font-light">{status.detail}</p>
      </header>

      <div className="h-px bg-border/60" />

      {/* Activity log — visible when live or has entries */}
      {(isLive || activityLog.length > 0) && (
        <section className="policy-fade-up" style={{ animationDelay: '40ms' }}>
          <ActivityLog entries={activityLog} isLive={isLive} />
        </section>
      )}

      {/* Summary stats */}
      {review.summary && (
        <section className="policy-fade-up grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ animationDelay: '80ms' }}>
          <div className="border border-border/50 bg-card/80 rounded-lg px-3 py-2">
            <p className="text-xs text-muted-foreground font-light">Recommendation</p>
            <p className="text-sm font-semibold text-foreground">{recommendationLabel(review.summary.recommendation)}</p>
          </div>
          <div className="border border-border/50 bg-card/80 rounded-lg px-3 py-2">
            <p className="text-xs text-muted-foreground font-light">Risk</p>
            <p className="text-sm font-semibold text-foreground capitalize">{review.summary.riskLevel}</p>
          </div>
          <div className="border border-border/50 bg-card/80 rounded-lg px-3 py-2">
            <p className="text-xs text-muted-foreground font-light">Findings</p>
            <p className="text-sm font-semibold text-foreground">{findingCount(review)}</p>
          </div>
          <div className="border border-border/50 bg-card/80 rounded-lg px-3 py-2">
            <p className="text-xs text-muted-foreground font-light">Finished</p>
            <p className="text-sm font-semibold text-foreground">{dateTimeLabel(review.finishedAt)}</p>
          </div>
        </section>
      )}

      {/* Failure guidance */}
      {failureGuidance && (
        <section className="policy-fade-up border border-red-200 bg-red-50/50 rounded-lg px-4 py-3 space-y-1">
          <p className="text-sm font-semibold text-red-800">{failureGuidance.headline}</p>
          <p className="text-sm text-red-700 font-light">{failureGuidance.details}</p>
          <ul className="text-sm text-red-700 font-light list-disc pl-5 space-y-0.5">
            {failureGuidance.actions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {/* Provenance */}
      {(review.provenance.promptSummary || cochangeBanner || contextResolutionBanner || review.provenance.sessionIds.length > 0 || provenanceAdvisories.length > 0) && (
        <section className="policy-fade-up border border-border/50 bg-card/60 rounded-lg px-4 py-3 space-y-2">
          <h2 className="policy-heading text-base text-foreground">Provenance</h2>
          <ul className="text-sm text-foreground/80 font-light space-y-1.5 list-disc pl-5">
            {review.provenance.promptSummary && (
              <li>{review.provenance.promptSummary}</li>
            )}
            {review.provenance.sessionIds.length > 0 && (
              <li>
                <span className="text-muted-foreground">Sessions:</span>{' '}
                <span className="font-mono text-xs">{review.provenance.sessionIds.join(', ')}</span>
              </li>
            )}
            {cochangeBanner && <li>{cochangeBanner}</li>}
            {contextResolutionBanner && (
              <li className="text-amber-700">{contextResolutionBanner}</li>
            )}
            {provenanceAdvisories.map((item) => (
              <li key={item} className="text-muted-foreground">{item}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Findings */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="policy-heading text-lg text-foreground">Findings</h2>
          {review.findings.length > 0 && (
            <div className="flex gap-1">
              <button type="button" className="report-copy-btn text-xs" onClick={handleCopyAllFindings}>
                Copy all findings
              </button>
              <button type="button" className="report-copy-btn text-xs" onClick={() => handleCopy(JSON.stringify(review.findings, null, 2))}>
                Copy as JSON
              </button>
            </div>
          )}
        </div>

        {review.findings.length === 0 ? (
          <div className="border border-border/50 bg-card/60 rounded-lg px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground font-light">
              {isLive ? 'Findings will appear here as the review progresses...' : 'No findings were reported.'}
            </p>
            {isLive && (
              <div className="flex items-center justify-center gap-2 pt-3">
                <span className="policy-derivation-dot" />
                <span className="policy-derivation-dot" />
                <span className="policy-derivation-dot" />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {review.findings.map((finding, index) => (
              <FindingCard
                key={`${finding.category}-${finding.severity}-${finding.description.slice(0, 40)}-${index}`}
                finding={finding}
                index={index}
                onCopy={(text) => { void handleCopy(text); }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Markdown summary */}
      {!markdownUnavailable && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="policy-heading text-lg text-foreground">Summary</h2>
            <div className="flex gap-1">
              <button type="button" className="report-copy-btn text-xs" onClick={() => handleCopy(normalizedMarkdown)}>
                Copy markdown
              </button>
              <button type="button" className="report-copy-btn text-xs" onClick={handleDownloadMarkdown}>
                Download .md
              </button>
            </div>
          </div>
          <article
            className="report-markdown border border-border/50 bg-card/80 rounded-lg px-5 py-4"
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        </section>
      )}

      {/* Export */}
      <section className="flex flex-col gap-2 pb-8">
        <div className="flex items-center justify-between">
          <h2 className="policy-heading text-lg text-foreground">Raw data</h2>
          <button type="button" className="report-copy-btn text-xs" onClick={handleDownloadJson}>
            Download .json
          </button>
        </div>
        <details className="border border-border/50 bg-card/80 rounded-lg overflow-hidden">
          <summary className="px-4 py-2.5 text-sm font-medium cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
            Show full JSON
          </summary>
          <pre className="px-4 py-3 text-xs font-mono overflow-x-auto bg-[hsl(240_10%_8%)] text-white/70 max-h-96 overflow-y-auto">
            {JSON.stringify(review, null, 2)}
          </pre>
        </details>
      </section>
    </main>
  );
}
