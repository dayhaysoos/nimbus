import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CompactHistoryText } from './CompactHistoryText';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import { parseListReviewsResponse } from '../lib/review';
import type { ListReviewsResponse, ReviewHistoryItem } from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 3000;
const ACTIVE_STATUSES: ReadonlySet<ReviewHistoryItem['status']> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

type StatusFilter = 'all' | 'succeeded' | 'failed' | 'running';
type SortDirection = 'newest' | 'oldest';

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

function riskLevelClass(riskLevel: ReviewHistoryItem['riskLevel']): string {
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
  return 'border-border bg-muted/40 text-muted-foreground';
}

function matchesStatusFilter(entry: ReviewHistoryItem, filter: StatusFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'running') {
    return ACTIVE_STATUSES.has(entry.status);
  }
  return entry.status === filter;
}

function reviewDestinationPath(entry: ReviewHistoryItem): string {
  const branchBase = `/branches/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.branch)}`;
  if (entry.status === 'policy_pending' || entry.status === 'policy_ready' || entry.status === 'policy_approved') {
    return `${branchBase}/policy/${entry.id}`;
  }
  return `${branchBase}/reports/${entry.id}`;
}

function asTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function BranchReviewsPage(): JSX.Element {
  const { repo = '', branch = '' } = useParams<{ repo: string; branch: string }>();
  const branchLabel = `${repo}/${branch}`;

  const [allEntries, setAllEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortDirection, setSortDirection] = useState<SortDirection>('newest');

  const fetchReviews = useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/reviews?limit=100`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 404) {
        throw new Error('This worker does not support review history yet. Deploy the latest worker build, then reload.');
      }
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }
    const payload = parseListReviewsResponse((await response.json()) as ListReviewsResponse);
    setAllEntries(payload.reviews);
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
    const timer = window.setInterval(() => { void refresh(); }, REVIEW_LIST_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [fetchReviews]);

  const branchEntries = useMemo(
    () => allEntries.filter((e) => e.repo === repo && e.branch === branch),
    [allEntries, repo, branch],
  );

  const stats = useMemo(() => {
    const active = branchEntries.filter((e) => ACTIVE_STATUSES.has(e.status)).length;
    const succeeded = branchEntries.filter((e) => e.status === 'succeeded').length;
    const failed = branchEntries.filter((e) => e.status === 'failed').length;
    let totalFindings = 0;
    for (const e of branchEntries) {
      totalFindings += e.findingCount ?? 0;
    }
    return { total: branchEntries.length, active, succeeded, failed, totalFindings };
  }, [branchEntries]);

  const visibleEntries = useMemo(() => {
    const filtered = branchEntries.filter((e) => matchesStatusFilter(e, statusFilter));
    return filtered.sort((a, b) => {
      const aTime = asTimestamp(a.createdAt) ?? 0;
      const bTime = asTimestamp(b.createdAt) ?? 0;
      return sortDirection === 'newest' ? bTime - aTime : aTime - bTime;
    });
  }, [branchEntries, sortDirection, statusFilter]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:py-5">
      {/* Header */}
      <header className="policy-fade-up flex flex-col gap-2" style={{ animationDelay: '0ms' }}>
        <div className="flex items-center gap-2">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Branches
          </Link>
          <span className="text-xs text-muted-foreground/50">/</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="policy-heading text-xl text-foreground tracking-tight truncate">{branchLabel}</h1>
            {stats.active > 0 && (
              <Badge variant="outline" className="rounded-full border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-blue-800 shrink-0">
                {stats.active} active
              </Badge>
            )}
          </div>
          <span className="text-sm text-muted-foreground shrink-0">{stats.total} review{stats.total === 1 ? '' : 's'}</span>
        </div>
      </header>

      <div className="h-px bg-border/60" />

      {/* Stats */}
      <section className="policy-fade-up grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ animationDelay: '40ms' }}>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Total</p>
          <p className="text-lg font-semibold text-foreground">{stats.total}</p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Succeeded</p>
          <p className="text-lg font-semibold text-emerald-700">{stats.succeeded}</p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Failed</p>
          <p className="text-lg font-semibold text-red-700">{stats.failed}</p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Total findings</p>
          <p className="text-lg font-semibold text-foreground">{stats.totalFindings}</p>
        </div>
      </section>

      {/* Filters */}
      <div className="policy-fade-up flex flex-wrap items-center gap-2" style={{ animationDelay: '60ms' }}>
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Status</span>
        {(['all', 'succeeded', 'failed', 'running'] as const).map((f) => (
          <Button
            key={f}
            type="button"
            size="sm"
            variant={statusFilter === f ? 'secondary' : 'ghost'}
            className="h-7 px-2 text-xs capitalize"
            onClick={() => setStatusFilter(f)}
          >
            {f}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2 text-xs"
          onClick={() => setSortDirection((v) => (v === 'newest' ? 'oldest' : 'newest'))}
        >
          {sortDirection === 'newest' ? 'Newest first' : 'Oldest first'}
        </Button>
      </div>

      {/* List */}
      {loading ? (
        <div className="policy-fade-up text-center py-8 space-y-3">
          <p className="text-sm text-muted-foreground font-light">Loading reviews...</p>
          <div className="flex items-center justify-center gap-2">
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
          </div>
        </div>
      ) : errorMessage ? (
        <div className="card status-card">
          <h2>Unable to load reviews</h2>
          <p>{errorMessage}</p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="border border-border/50 bg-card/60 rounded-lg px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground font-light">
            {branchEntries.length === 0
              ? 'No reviews found for this branch.'
              : 'No reviews match this filter.'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleEntries.map((entry, index) => (
            <li key={entry.id} className="report-finding-enter" style={{ animationDelay: `${80 + index * 30}ms` }}>
              <Link to={reviewDestinationPath(entry)} className="block">
                <Card
                  className={cn(
                    'px-3 py-2.5 transition-colors hover:bg-accent/30',
                    entry.status === 'failed' && 'border-l-4 border-l-rose-400 bg-rose-50/55',
                    entry.status === 'cancelled' && 'border-l-4 border-l-red-300 bg-red-50/40'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <StatusPill status={entry.status} />
                      {entry.riskLevel && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]',
                            riskLevelClass(entry.riskLevel)
                          )}
                        >
                          {entry.riskLevel}
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className="rounded-full border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        {entry.findingCount ?? 0} finding{entry.findingCount === 1 ? '' : 's'}
                      </Badge>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(entry.createdAt)}</span>
                  </div>
                  <CompactHistoryText
                    className="mt-1.5 text-sm text-foreground/80"
                    text={entry.summaryText ?? entry.id}
                  />
                  <p className="mt-0.5 text-[11px] text-muted-foreground/60 font-mono">{entry.id}</p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
