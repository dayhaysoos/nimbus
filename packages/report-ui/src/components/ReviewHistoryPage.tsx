import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CompactHistoryText } from './CompactHistoryText';
import { parseListReviewsResponse } from '../lib/review';
import type { ListReviewsResponse, ReviewHistoryItem } from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 2000;
const ACTIVE_STATUSES: ReadonlySet<ReviewHistoryItem['status']> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

function statusClass(status: ReviewHistoryItem['status']): string {
  switch (status) {
    case 'succeeded':
      return 'history-status history-status-succeeded';
    case 'failed':
    case 'cancelled':
      return 'history-status history-status-failed';
    case 'running':
    case 'queued':
    case 'policy_pending':
    case 'policy_ready':
    case 'policy_approved':
      return 'history-status history-status-active';
    default:
      return 'history-status history-status-unknown';
  }
}

function statusLabel(status: ReviewHistoryItem['status']): string {
  return status.replace(/_/g, ' ');
}

function relativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'unknown time';
  }

  const diffMs = Date.now() - date.getTime();
  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
  if (absSeconds < 60) {
    return 'just now';
  }

  const inFuture = diffMs < 0;
  const absMinutes = Math.floor(absSeconds / 60);
  if (absMinutes < 60) {
    return inFuture ? `in ${absMinutes}m` : `${absMinutes}m ago`;
  }
  const absHours = Math.floor(absMinutes / 60);
  if (absHours < 24) {
    return inFuture ? `in ${absHours}h` : `${absHours}h ago`;
  }
  const absDays = Math.floor(absHours / 24);
  return inFuture ? `in ${absDays}d` : `${absDays}d ago`;
}

function metadataLine(entry: ReviewHistoryItem): string {
  const parts: string[] = [relativeTime(entry.updatedAt)];
  if (typeof entry.findingCount === 'number') {
    parts.push(`${entry.findingCount} finding${entry.findingCount === 1 ? '' : 's'}`);
  }
  if (entry.riskLevel) {
    parts.push(`risk ${entry.riskLevel}`);
  }
  if (entry.recommendation) {
    parts.push(`recommendation ${entry.recommendation.replace(/_/g, ' ')}`);
  }
  return parts.join(' | ');
}

function reviewDestinationPath(entry: ReviewHistoryItem): string {
  if (entry.status === 'policy_pending' || entry.status === 'policy_ready' || entry.status === 'policy_approved') {
    return `/policy/${entry.id}`;
  }
  return `/reports/${entry.id}`;
}

export function ReviewHistoryPage(): JSX.Element {
  const [entries, setEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/reviews?limit=100`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 404) {
        throw new Error(
          'This worker does not support review history yet (missing GET /api/reviews). Deploy the latest worker build, then reload.'
        );
      }
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }

    const payload = parseListReviewsResponse((await response.json()) as ListReviewsResponse);
    setEntries(payload.reviews);
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        await fetchReviews();
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REVIEW_LIST_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fetchReviews]);

  const summaryCount = useMemo(() => {
    const active = entries.filter((entry) => ACTIVE_STATUSES.has(entry.status)).length;
    return {
      total: entries.length,
      active,
    };
  }, [entries]);

  return (
    <main className="page history-page">
      <section className="card history-header">
        <div>
          <h1>Review history</h1>
          <p>Recent backend review runs. New policy drafts appear here automatically.</p>
        </div>
        <dl>
          <div>
            <dt>Total</dt>
            <dd>{summaryCount.total}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{summaryCount.active}</dd>
          </div>
        </dl>
      </section>

      {loading ? (
        <section className="card status-card history-empty">
          <h2>Loading review history</h2>
          <p>Fetching existing reviews from the backend.</p>
        </section>
      ) : null}

      {!loading && errorMessage ? (
        <section className="card status-card history-empty">
          <h2>Unable to load review history</h2>
          <p>{errorMessage}</p>
        </section>
      ) : null}

      {!loading && !errorMessage && entries.length === 0 ? (
        <section className="card status-card history-empty">
          <h2>No reviews yet</h2>
          <p>Run <code>nimbus review open</code> to create a review, or keep this page open with <code>nimbus review start</code>.</p>
        </section>
      ) : (
        !loading && !errorMessage && <section className="card history-list-card">
          <ul className="history-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link to={reviewDestinationPath(entry)} className="history-link">
                  <div className="history-row-main">
                    <span className="history-review-id">{entry.id}</span>
                    <span className={statusClass(entry.status)}>{statusLabel(entry.status)}</span>
                  </div>
                  <p className="history-meta">{metadataLine(entry)}</p>
                  <CompactHistoryText
                    className="history-summary"
                    text={entry.summaryText ?? `${entry.repo} @ ${entry.branch}`}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
