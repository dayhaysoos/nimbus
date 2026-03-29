import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyToClipboard } from '../lib/clipboard';
import { downloadTextFile } from '../lib/download';
import { StatusPill } from './ui/StatusPill';
import {
  buildFindingText,
  buildFixPrompt,
  dateTimeLabel,
  findingCount,
  parseGetReviewResponse,
  recommendationLabel,
  reviewFailureGuidance,
  statusNarrative,
} from '../lib/review';
import type { GetReviewResponse, ReviewFinding, ReviewResponse } from '../types';
import { cn } from '../lib/utils';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';

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

function FindingCard(props: {
  finding: ReviewFinding;
  index: number;
  onCopyFinding: (item: ReviewFinding) => void;
  onCopyPrompt: (item: ReviewFinding) => void;
}): JSX.Element {
  const { finding, index, onCopyFinding, onCopyPrompt } = props;
  const locationsText = finding.locations.length
    ? finding.locations
        .map((item) =>
          item.startLine !== null && item.endLine !== null
            ? `${item.filePath}:${item.startLine}-${item.endLine}`
            : item.filePath
        )
        .join(', ')
    : 'none provided';

  return (
    <article
      className="report-finding-enter border border-border/50 bg-card/80 rounded-lg overflow-hidden"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          className={cn(
            'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wider border shrink-0 mt-0.5',
            severityColor(finding.severity)
          )}
        >
          {finding.severity}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-snug">{finding.description}</p>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tracking-wide">
              {finding.category}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground tracking-wide">
              {`pass ${finding.passType}`}
            </span>
            <span className="text-xs text-muted-foreground/60 font-mono">{locationsText}</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-2.5 border-t border-border/30 bg-accent/20">
        <p className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider mb-0.5">Suggested fix</p>
        <p className="text-sm text-foreground/90 leading-relaxed">{finding.suggestedFix?.trim() || 'not provided'}</p>
      </div>

      <div className="flex items-center gap-1 px-4 py-2 border-t border-border/30 bg-card/70">
        <button type="button" className="report-copy-btn text-xs" onClick={() => onCopyFinding(finding)}>
          Copy finding
        </button>
        <button type="button" className="report-copy-btn text-xs" onClick={() => onCopyPrompt(finding)}>
          Copy fix prompt
        </button>
      </div>
    </article>
  );
}

export function ReportPage(): JSX.Element {
  const { reviewId } = useParams<{ reviewId: string }>();

  const [state, setState] = useState<LoadState>('loading');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [refreshCycle, setRefreshCycle] = useState(0);

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

    const onMessage = () => {
      setRefreshCycle((value) => value + 1);
    };

    const onError = () => {
      stream.close();
      window.setTimeout(() => {
        setRefreshCycle((value) => value + 1);
      }, 1000);
    };

    stream.addEventListener('message', onMessage);
    stream.addEventListener('error', onError);

    return () => {
      stream.removeEventListener('message', onMessage);
      stream.removeEventListener('error', onError);
      stream.close();
    };
  }, [review, state]);

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
        <div className="policy-fade-up text-center space-y-3">
          <p className="policy-clause-number">loading</p>
          <h1 className="policy-heading text-xl text-foreground">Loading review</h1>
          <p className="text-sm text-muted-foreground font-light">Fetching review {reviewId ?? 'unknown'}...</p>
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
        <div className="policy-fade-up text-center space-y-3 max-w-lg">
          <p className="policy-clause-number text-destructive/70">error</p>
          <h1 className="policy-heading text-xl text-foreground">Unable to load review</h1>
          <p className="text-sm text-muted-foreground font-light">{errorMessage || 'Unknown error'}</p>
        </div>
      </StatusLayout>
    );
  }

  if (!review) {
    return (
      <StatusLayout>
        <div className="policy-fade-up text-center space-y-3">
          <p className="policy-clause-number">empty</p>
          <h1 className="policy-heading text-xl text-foreground">No review data</h1>
          <p className="text-sm text-muted-foreground font-light">The review payload is empty.</p>
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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-4 md:py-6">
      {toastMessage && <div className="report-toast">{toastMessage}</div>}

      <section className="policy-fade-up card summary-card" style={{ animationDelay: '0ms' }}>
        <div className="summary-header">
          <h1>Review {review.id}</h1>
          <StatusPill status={review.status} />
        </div>
        <dl className="summary-grid">
          <div>
            <dt>Recommendation</dt>
            <dd>{recommendationLabel(review.summary?.recommendation)}</dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd>{review.summary?.riskLevel ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd>{findingCount(review)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{dateTimeLabel(review.createdAt)}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{dateTimeLabel(review.startedAt)}</dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>{dateTimeLabel(review.finishedAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{dateTimeLabel(review.updatedAt)}</dd>
          </div>
        </dl>
        <div className="button-row">
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
        <section className="policy-fade-up border border-red-200 bg-red-50/50 rounded-lg px-4 py-3 space-y-1" style={{ animationDelay: '60ms' }}>
          <h2 className="text-base font-semibold text-red-800">Failure guidance</h2>
          <p className="text-sm text-red-700">{failureGuidance.headline}</p>
          <p className="text-sm text-red-700">{failureGuidance.details}</p>
          <ul className="text-sm text-red-700 list-disc pl-5 space-y-0.5">
            {failureGuidance.actions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {cochangeBanner && (
        <section className="policy-fade-up card status-card" style={{ animationDelay: '80ms' }}>
          <h2>Co-change context</h2>
          <p>{cochangeBanner}</p>
        </section>
      )}

      {contextResolutionBanner && (
        <section className="policy-fade-up card status-card" style={{ animationDelay: '100ms' }}>
          <h2>Context fallback used</h2>
          <p>{contextResolutionBanner}</p>
          {review.provenance.contextResolution && (
            <dl className="summary-grid mt-2">
              <div>
                <dt>Original checkpoint</dt>
                <dd>{review.provenance.contextResolution.originalCheckpointId}</dd>
              </div>
              <div>
                <dt>Resolved checkpoint</dt>
                <dd>{review.provenance.contextResolution.resolvedCheckpointId}</dd>
              </div>
              <div>
                <dt>Resolved commit</dt>
                <dd>{review.provenance.contextResolution.resolvedCommitSha.slice(0, 12)}</dd>
              </div>
            </dl>
          )}
        </section>
      )}

      {provenanceAdvisories.length > 0 && (
        <section className="policy-fade-up card status-card" style={{ animationDelay: '120ms' }}>
          <h2>Advisories</h2>
          <ul>
            {provenanceAdvisories.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="policy-fade-up section-block" style={{ animationDelay: '140ms' }}>
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

      <section className="policy-fade-up flex flex-col gap-3" style={{ animationDelay: '160ms' }}>
        <div className="flex items-center justify-between">
          <h2 className="policy-heading text-lg text-foreground">Findings</h2>
          {review.findings.length > 0 && (
            <div className="flex gap-1">
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
          )}
        </div>

        {review.findings.length === 0 ? (
          <div className="card">
            <p>No findings were reported.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {review.findings.map((finding, index) => (
              <FindingCard
                key={`${finding.category}-${finding.passType}-${finding.severity}-${finding.description}-${finding.locations
                  .map((location) => `${location.filePath}:${location.startLine ?? 'null'}:${location.endLine ?? 'null'}`)
                  .join('|')}-${finding.suggestedFix}`}
                finding={finding}
                index={index}
                onCopyFinding={(item) => {
                  void handleCopy(buildFindingText(item));
                }}
                onCopyPrompt={(item) => {
                  void handleCopy(buildFixPrompt(item));
                }}
              />
            ))}
          </div>
        )}
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
