import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import { parseListReviewsResponse } from '../lib/review';
import type { ListReviewsResponse, ReviewHistoryItem, ReviewStatus } from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 3000;
const ACTIVE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

interface BranchGroup {
  repo: string;
  branch: string;
  key: string;
  reviews: ReviewHistoryItem[];
  latestReview: ReviewHistoryItem;
  activeCount: number;
  succeededCount: number;
  failedCount: number;
  totalFindings: number;
  worstRisk: ReviewHistoryItem['riskLevel'];
}

const RISK_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function worstRiskLevel(reviews: ReviewHistoryItem[]): ReviewHistoryItem['riskLevel'] {
  let worst: ReviewHistoryItem['riskLevel'] = null;
  let worstScore = 0;
  for (const r of reviews) {
    if (r.riskLevel) {
      const score = RISK_ORDER[r.riskLevel] ?? 0;
      if (score > worstScore) {
        worstScore = score;
        worst = r.riskLevel;
      }
    }
  }
  return worst;
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

function relativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
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

function latestStatus(reviews: ReviewHistoryItem[]): ReviewStatus {
  return reviews[0]?.status ?? 'queued';
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
        throw new Error('This worker does not support review history yet. Deploy the latest worker build, then reload.');
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
    const timer = window.setInterval(() => { void refresh(); }, REVIEW_LIST_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [fetchReviews]);

  const branches = useMemo((): BranchGroup[] => {
    const map = new Map<string, ReviewHistoryItem[]>();

    // Sort all entries newest first
    const sorted = [...entries].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime() || 0;
      const bTime = new Date(b.createdAt).getTime() || 0;
      return bTime - aTime;
    });

    for (const entry of sorted) {
      const key = `${entry.repo}/${entry.branch}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(key, [entry]);
      }
    }

    const groups: BranchGroup[] = [];
    for (const [key, reviews] of map) {
      const first = reviews[0]!;
      let activeCount = 0;
      let succeededCount = 0;
      let failedCount = 0;
      let totalFindings = 0;

      for (const r of reviews) {
        if (ACTIVE_STATUSES.has(r.status)) {
          activeCount++;
        }
        if (r.status === 'succeeded') {
          succeededCount++;
        }
        if (r.status === 'failed') {
          failedCount++;
        }
        totalFindings += r.findingCount ?? 0;
      }

      groups.push({
        repo: first.repo,
        branch: first.branch,
        key,
        reviews,
        latestReview: first,
        activeCount,
        succeededCount,
        failedCount,
        totalFindings,
        worstRisk: worstRiskLevel(reviews),
      });
    }

    // Sort branches by most recent review
    groups.sort((a, b) => {
      const aTime = new Date(a.latestReview.createdAt).getTime() || 0;
      const bTime = new Date(b.latestReview.createdAt).getTime() || 0;
      return bTime - aTime;
    });

    return groups;
  }, [entries]);

  const globalStats = useMemo(() => {
    const active = entries.filter((e) => ACTIVE_STATUSES.has(e.status)).length;
    const succeeded = entries.filter((e) => e.status === 'succeeded').length;
    return {
      totalReviews: entries.length,
      totalBranches: branches.length,
      active,
      passRate: entries.length > 0 ? Math.round((succeeded / entries.length) * 100) : 0,
    };
  }, [entries, branches]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:py-5">
      {/* Header */}
      <header className="policy-fade-up flex flex-col gap-2" style={{ animationDelay: '0ms' }}>
        <div className="flex items-center justify-between gap-3">
          <h1 className="policy-heading text-xl text-foreground tracking-tight">Nimbus Reviews</h1>
          {globalStats.active > 0 && (
            <Badge variant="outline" className="rounded-full border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-blue-800">
              {globalStats.active} active
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground font-light">
          Select a branch to view its review history.
        </p>
      </header>

      <div className="h-px bg-border/60" />

      {/* Global stats */}
      <section className="policy-fade-up grid grid-cols-2 sm:grid-cols-4 gap-2" style={{ animationDelay: '40ms' }}>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Branches</p>
          <p className="text-lg font-semibold text-foreground">{globalStats.totalBranches}</p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Total reviews</p>
          <p className="text-lg font-semibold text-foreground">{globalStats.totalReviews}</p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Pass rate</p>
          <p className="text-lg font-semibold text-foreground">
            {globalStats.totalReviews === 0 ? 'n/a' : `${globalStats.passRate}%`}
          </p>
        </div>
        <div className="rounded-md border border-border/70 bg-card/70 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Active</p>
          <p className="text-lg font-semibold text-foreground">{globalStats.active}</p>
        </div>
      </section>

      {/* Branch list */}
      {loading ? (
        <div className="policy-fade-up text-center py-8 space-y-3">
          <p className="text-sm text-muted-foreground font-light">Loading branches...</p>
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
      ) : branches.length === 0 ? (
        <div className="border border-border/50 bg-card/60 rounded-lg px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground font-light">
            No reviews yet. Run <code className="text-xs bg-muted/50 px-1.5 py-0.5 rounded">nimbus review open</code> to create your first review.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {branches.map((group, index) => (
            <li key={group.key} className="report-finding-enter" style={{ animationDelay: `${60 + index * 40}ms` }}>
              <Link to={`/branches/${encodeURIComponent(group.repo)}/${encodeURIComponent(group.branch)}`}>
                <Card className="px-4 py-3 transition-colors hover:bg-accent/30">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold text-foreground truncate">{group.branch}</h2>
                        <span className="text-xs text-muted-foreground/60 font-mono truncate">{group.repo}</span>
                      </div>

                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <StatusPill status={latestStatus(group.reviews)} />
                        {group.worstRisk && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]',
                              riskLevelClass(group.worstRisk)
                            )}
                          >
                            {group.worstRisk} risk
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {group.reviews.length} review{group.reviews.length === 1 ? '' : 's'}
                        </span>
                        {group.totalFindings > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {group.totalFindings} finding{group.totalFindings === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>

                      {group.latestReview.summaryText && (
                        <p className="mt-1.5 text-sm text-foreground/70 font-light line-clamp-1">
                          {group.latestReview.summaryText}
                        </p>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground">{relativeTime(group.latestReview.createdAt)}</p>
                      <div className="flex gap-1 mt-1 justify-end">
                        {group.succeededCount > 0 && (
                          <span className="text-[10px] font-medium text-emerald-700">{group.succeededCount} passed</span>
                        )}
                        {group.failedCount > 0 && (
                          <span className="text-[10px] font-medium text-red-700">{group.failedCount} failed</span>
                        )}
                        {group.activeCount > 0 && (
                          <span className="text-[10px] font-medium text-blue-700">{group.activeCount} active</span>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
