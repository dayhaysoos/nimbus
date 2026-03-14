import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyToClipboard } from '../lib/clipboard';
import { downloadTextFile } from '../lib/download';
import {
  buildFindingText,
  buildFixPrompt,
  dateTimeLabel,
  findingCount,
  recommendationLabel,
} from '../lib/review';
import type { GetReviewResponse, ReviewFinding, ReviewResponse } from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';

function copyButton(onClick: () => void, label: string, disabled = false): JSX.Element {
  return (
    <button type="button" className="secondary-button" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

function statusMessage(review: ReviewResponse): string | null {
  if (review.status === 'queued') {
    return 'Review is queued and has not started yet.';
  }
  if (review.status === 'running') {
    return 'Review is currently running.';
  }
  if (review.status === 'failed') {
    return review.error?.message ?? 'Review failed before a full report was generated.';
  }
  if (review.status === 'cancelled') {
    return 'Review was cancelled before completion.';
  }

  return null;
}

function cochangeStatusMessage(review: ReviewResponse): string | null {
  const coChange = review.provenance?.coChange;
  if (!coChange) {
    return null;
  }
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

  const normalizedMarkdown = withoutEvidenceSection.replace(/^(#{1,6})\s+Intent\b/gm, '$1 Policy');
  return normalizedMarkdown.trim();
}

function renderedMarkdown(markdown: string): string {
  if (!markdown.trim()) {
    return '<p>No markdown summary available for this review.</p>';
  }

  return DOMPurify.sanitize(marked.parse(markdown) as string);
}

function findingCard(
  keyId: string,
  finding: ReviewFinding,
  onCopyFinding: (item: ReviewFinding) => void,
  onCopyPrompt: (item: ReviewFinding) => void
): JSX.Element {
  return (
    <article key={keyId} className="card finding-card">
      <header>
        <h3>{finding.description}</h3>
        <p className="finding-meta">
          <span>Severity: {finding.severity}</span>
          <span>Category: {finding.category}</span>
          <span>Pass: {finding.passType}</span>
        </p>
      </header>
      <dl className="finding-details">
        <div>
          <dt>Locations</dt>
          <dd>
            {finding.locations.length
              ? finding.locations
                  .map((item) =>
                    item.startLine !== null && item.endLine !== null
                      ? `${item.filePath}:${item.startLine}-${item.endLine}`
                      : item.filePath
                  )
                  .join(', ')
              : 'none provided'}
          </dd>
        </div>
        <div>
          <dt>Suggested fix</dt>
          <dd>{finding.suggestedFix?.trim() || 'not provided'}</dd>
        </div>
      </dl>
      <div className="button-row">
        {copyButton(() => onCopyFinding(finding), 'Copy finding')}
        {copyButton(() => onCopyPrompt(finding), 'Copy fix prompt')}
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

  useEffect(() => {
    if (!reviewId) {
      setState('error');
      setErrorMessage('Missing review id in URL.');
      return;
    }

    let cancelled = false;
    setState('loading');

    fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          const message = body?.error ?? `Request failed (${response.status})`;
          throw new Error(message);
        }

        const data = (await response.json()) as GetReviewResponse;
        if (!data.review) {
          throw new Error('No review payload in response.');
        }

        if (!cancelled) {
          setReview(data.review);
          setState('loaded');
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
  }, [reviewId]);

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

  const showCopied = () => {
    setToastMessage('Copied');
  };

  const handleCopy = async (text: string) => {
    try {
      await copyToClipboard(text);
      showCopied();
    } catch {
      setToastMessage('Copy failed');
    }
  };

  const handleDownloadMarkdown = () => {
    if (!reviewId || !review) {
      return;
    }

    downloadTextFile(`${reviewId}.md`, normalizedMarkdown, 'text/markdown');
  };

  const handleDownloadJson = () => {
    if (!reviewId || !review) {
      return;
    }

    downloadTextFile(`${reviewId}.json`, JSON.stringify(review, null, 2), 'application/json');
  };

  if (state === 'loading') {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>Loading review</h1>
          <p>Fetching review {reviewId ?? 'unknown'}...</p>
        </section>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>Unable to load review</h1>
          <p>{errorMessage || 'Unknown error'}</p>
        </section>
      </main>
    );
  }

  if (!review) {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>No review data</h1>
          <p>The review payload is empty.</p>
        </section>
      </main>
    );
  }

  const statusBanner = statusMessage(review);
  const cochangeBanner = cochangeStatusMessage(review);
  const markdownUnavailable = normalizedMarkdown.length === 0;

  return (
    <main className="page">
      {toastMessage && <div className="toast">{toastMessage}</div>}

      <section className="card summary-card">
        <div className="summary-header">
          <h1>Review {review.id}</h1>
          <span className={`status-pill status-${review.status}`}>{review.status}</span>
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
          {copyButton(() => handleCopy(normalizedMarkdown), 'Copy full markdown', markdownUnavailable)}
          {copyButton(() => handleCopy(JSON.stringify(review, null, 2)), 'Copy full JSON')}
          <button type="button" className="secondary-button" onClick={handleDownloadMarkdown} disabled={markdownUnavailable}>
            Download markdown
          </button>
          <button type="button" className="secondary-button" onClick={handleDownloadJson}>
            Download JSON
          </button>
        </div>
      </section>

      {statusBanner && (
        <section className="card status-card">
          <h2>Review status</h2>
          <p>{statusBanner}</p>
        </section>
      )}

      {cochangeBanner && (
        <section className="card status-card">
          <h2>Co-change context</h2>
          <p>{cochangeBanner}</p>
        </section>
      )}

      <section className="section-block">
        <h2>Findings</h2>
        {review.findings.length === 0 ? (
          <div className="card">
            <p>No findings were reported.</p>
          </div>
        ) : (
          <div className="stack">
            {review.findings.map((finding) =>
              findingCard(
                `${finding.category}-${finding.passType}-${finding.severity}-${finding.description}-${finding.locations
                  .map((location) => `${location.filePath}:${location.startLine ?? 'null'}:${location.endLine ?? 'null'}`)
                  .join('|')}-${finding.suggestedFix}`,
                finding,
                (item) => {
                  void handleCopy(buildFindingText(item));
                },
                (item) => {
                  void handleCopy(buildFixPrompt(item));
                }
              )
            )}
          </div>
        )}
      </section>

      <section className="section-block">
        <h2>Markdown summary</h2>
        <article className="card markdown-card" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      </section>

      <section className="section-block">
        <details className="card raw-json">
          <summary>Raw JSON</summary>
          <pre>{JSON.stringify(review, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
