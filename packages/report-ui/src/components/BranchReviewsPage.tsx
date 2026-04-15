import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CompactHistoryText } from './CompactHistoryText';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import { parseListReviewSessionsResponse } from '../lib/review';
import type { ReviewSessionListResponse, ReviewSessionResponse } from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const SESSION_LIST_POLL_MS = 3000;
const ACTIVE_PHASES: ReadonlySet<ReviewSessionResponse['phase']> = new Set([
  'preparing',
  'reviewing',
  'fixing',
  'verifying',
  'waiting_on_human',
]);

type StatusFilter = 'all' | 'completed' | 'failed' | 'active';
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

function phaseClass(phase: ReviewSessionResponse['phase']): string {
  if (phase === 'completed') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  }
  if (phase === 'failed' || phase === 'cancelled') {
    return 'border-rose-200 bg-rose-50 text-rose-900';
  }
  if (phase === 'waiting_on_human') {
    return 'border-amber-200 bg-amber-50 text-amber-900';
  }
  return 'border-sky-200 bg-sky-50 text-sky-900';
}

function matchesStatusFilter(entry: ReviewSessionResponse, filter: StatusFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'active') {
    return ACTIVE_PHASES.has(entry.phase);
  }
  if (filter === 'completed') {
    return entry.phase === 'completed';
  }
  return entry.phase === 'failed' || entry.phase === 'cancelled';
}

function sessionDestinationPath(entry: ReviewSessionResponse): string {
  const branchBase = `/branches/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.branch)}`;
  return `${branchBase}/sessions/${encodeURIComponent(entry.id)}`;
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

  const [allEntries, setAllEntries] = useState<ReviewSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortDirection, setSortDirection] = useState<SortDirection>('newest');

  const fetchSessions = useCallback(async () => {
    const response = await fetch(
      `${API_BASE}/api/review-sessions?limit=100&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 404) {
        throw new Error('This worker does not support review sessions yet. Deploy the latest worker build, then reload.');
      }
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }
    const payload = parseListReviewSessionsResponse((await response.json()) as ReviewSessionListResponse);
    setAllEntries(payload.sessions);
    setErrorMessage(null);
  }, [branch, repo]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        await fetchSessions();
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
    const timer = window.setInterval(() => { void refresh(); }, SESSION_LIST_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [fetchSessions]);

  const branchEntries = useMemo(
    () => allEntries.filter((e) => e.repo === repo && e.branch === branch),
    [allEntries, repo, branch],
  );

  const stats = useMemo(() => {
    const active = branchEntries.filter((e) => ACTIVE_PHASES.has(e.phase)).length;
    const completed = branchEntries.filter((e) => e.phase === 'completed').length;
    const failed = branchEntries.filter((e) => e.phase === 'failed' || e.phase === 'cancelled').length;
    let totalFindings = 0;
    for (const e of branchEntries) {
      totalFindings += e.outcome?.unresolved.findingCount ?? 0;
    }
    return { total: branchEntries.length, active, completed, failed, totalFindings };
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
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-2 px-3 py-2 md:py-3">
      {/* Header */}
      <header className="policy-fade-up flex flex-col gap-2" style={{ animationDelay: '0ms' }}>
        <div className="flex items-center gap-2">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Studio Home
          </Link>
          <span className="text-xs text-muted-foreground/50">/</span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="policy-heading text-base text-foreground tracking-tight truncate">{branchLabel}</h1>
              <Badge variant="outline" className="rounded-full border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground shrink-0">
                Branch history
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Browse previous sessions for this branch. Start new sessions from Studio Home on the current working branch.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {stats.active > 0 && (
              <Badge variant="outline" className="rounded-full border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-blue-800 shrink-0">
                {stats.active} active
              </Badge>
            )}
            <span className="text-sm text-muted-foreground">{stats.total} session{stats.total === 1 ? '' : 's'}</span>
          </div>
        </div>
      </header>

      <div className="h-px bg-border/60" />

      {/* Stats */}
      <section className="policy-fade-up grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ animationDelay: '40ms' }}>
        <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Total</p>
          <p className="text-sm font-semibold text-foreground">{stats.total}</p>
        </div>
        <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Completed</p>
          <p className="text-sm font-semibold text-emerald-700">{stats.completed}</p>
        </div>
        <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Failed</p>
          <p className="text-sm font-semibold text-red-700">{stats.failed}</p>
        </div>
        <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Total findings</p>
          <p className="text-sm font-semibold text-foreground">{stats.totalFindings}</p>
        </div>
      </section>

      {/* Filters */}
      <div className="policy-fade-up flex flex-wrap items-center gap-2" style={{ animationDelay: '60ms' }}>
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Status</span>
        {(['all', 'completed', 'failed', 'active'] as const).map((f) => (
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
          <p className="text-sm text-muted-foreground font-light">Loading sessions...</p>
          <div className="flex items-center justify-center gap-2">
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
          </div>
        </div>
      ) : errorMessage ? (
        <div className="card status-card">
          <h2>Unable to load sessions</h2>
          <p>{errorMessage}</p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="border border-border/50 bg-card/60 rounded-sm px-3 py-4 text-center">
          <p className="text-sm text-muted-foreground font-light">
            {branchEntries.length === 0
              ? 'No sessions found for this branch.'
              : 'No sessions match this filter.'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleEntries.map((entry, index) => (
            <li key={entry.id} className="report-finding-enter" style={{ animationDelay: `${80 + index * 30}ms` }}>
              <Link to={sessionDestinationPath(entry)} className="block">
                <Card
                  className={cn(
                    'px-3 py-2.5 transition-colors hover:bg-accent/30',
                    entry.phase === 'failed' && 'border-l-4 border-l-rose-400 bg-rose-50/55',
                    entry.phase === 'cancelled' && 'border-l-4 border-l-red-300 bg-red-50/40'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className={cn('rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]', phaseClass(entry.phase))}>
                        {entry.phase.replace(/_/g, ' ')}
                      </Badge>
                      {entry.currentReviewStatus && (
                        <Badge
                          variant="outline"
                          className="rounded-full border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                        >
                          {entry.currentReviewStatus.replace(/_/g, ' ')}
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className="rounded-full border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground"
                      >
                        {entry.passCount} pass{entry.passCount === 1 ? '' : 'es'}
                      </Badge>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(entry.createdAt)}</span>
                  </div>
                  <CompactHistoryText
                    className="mt-1.5 text-sm text-foreground/80"
                    text={entry.outcome?.summary ?? `Latest pass ${entry.latestReviewId ?? 'pending'}`}
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
