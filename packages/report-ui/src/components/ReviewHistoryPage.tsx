import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseListReviewsResponse, parseStudioContextResponse } from '../lib/review';
import type { ListReviewsResponse, ReviewHistoryItem, ReviewStatus, StudioContextResponse } from '../types';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 3000;
const BRANCH_CONTEXT_POLL_MS = 2000;
const ACTIVE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

interface BranchGroup {
  key: string;
  repo: string;
  branch: string;
  reviews: ReviewHistoryItem[];
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

function reviewDestinationPath(entry: ReviewHistoryItem): string {
  const branchBase = `/branches/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.branch)}`;
  if (entry.status === 'policy_pending' || entry.status === 'policy_ready' || entry.status === 'policy_approved') {
    return `${branchBase}/policy/${entry.id}`;
  }
  return `${branchBase}/reports/${entry.id}`;
}

export function ReviewHistoryPage(): JSX.Element {
  const [entries, setEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [studioContext, setStudioContext] = useState<StudioContextResponse | null>(null);
  const [selectedBranchKey, setSelectedBranchKey] = useState<string | null>(null);
  const [pendingBranchSwitchKey, setPendingBranchSwitchKey] = useState<string | null>(null);
  const [lastDetectedBranchKey, setLastDetectedBranchKey] = useState<string | null>(null);
  const [showNewReviewPanel, setShowNewReviewPanel] = useState(false);

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

  const fetchStudioContext = useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/studio/context`);
    if (!response.ok) {
      throw new Error(`Failed to load studio context (${response.status})`);
    }
    const payload = parseStudioContextResponse(await response.json());
    setStudioContext(payload);
  }, []);

  useEffect(() => {
    const detectedKey = studioContext?.repo && studioContext?.branch ? `${studioContext.repo}/${studioContext.branch}` : null;
    if (!detectedKey) {
      return;
    }
    if (!selectedBranchKey) {
      setSelectedBranchKey(detectedKey);
    }
    if (!lastDetectedBranchKey) {
      setLastDetectedBranchKey(detectedKey);
      return;
    }
    if (detectedKey !== lastDetectedBranchKey) {
      if (selectedBranchKey && detectedKey !== selectedBranchKey) {
        setPendingBranchSwitchKey(detectedKey);
      } else {
        setPendingBranchSwitchKey(null);
      }
      setLastDetectedBranchKey(detectedKey);
      return;
    }
    if (pendingBranchSwitchKey && selectedBranchKey && detectedKey === selectedBranchKey) {
      setPendingBranchSwitchKey(null);
    }
  }, [studioContext, selectedBranchKey, lastDetectedBranchKey, pendingBranchSwitchKey]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        await Promise.all([fetchReviews(), fetchStudioContext()]);
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
    const reviewTimer = window.setInterval(() => {
      void fetchReviews().catch((error) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });
    }, REVIEW_LIST_POLL_MS);
    const branchTimer = window.setInterval(() => {
      void fetchStudioContext().catch(() => undefined);
    }, BRANCH_CONTEXT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(reviewTimer);
      window.clearInterval(branchTimer);
    };
  }, [fetchReviews, fetchStudioContext]);

  const branches = useMemo((): BranchGroup[] => {
    const sorted = [...entries].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime() || 0;
      const bTime = new Date(b.createdAt).getTime() || 0;
      return bTime - aTime;
    });
    const map = new Map<string, BranchGroup>();
    for (const entry of sorted) {
      const key = `${entry.repo}/${entry.branch}`;
      const existing = map.get(key);
      if (existing) {
        existing.reviews.push(entry);
      } else {
        map.set(key, {
          key,
          repo: entry.repo,
          branch: entry.branch,
          reviews: [entry],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const aTime = new Date(a.reviews[0]?.createdAt ?? 0).getTime() || 0;
      const bTime = new Date(b.reviews[0]?.createdAt ?? 0).getTime() || 0;
      return bTime - aTime;
    });
  }, [entries]);

  const fallbackBranchKey = branches[0]?.key ?? null;
  const activeBranchKey = selectedBranchKey ?? fallbackBranchKey;
  const activeBranch = branches.find((b) => b.key === activeBranchKey) ?? branches[0] ?? null;
  const detectedBranchLabel = studioContext?.branch ?? 'unknown';
  const detectedRepoLabel = studioContext?.repo ?? 'repo unavailable';
  const viewingDifferentContext = Boolean(
    activeBranch &&
    studioContext?.repo &&
    studioContext?.branch &&
    activeBranch.key !== `${studioContext.repo}/${studioContext.branch}`
  );
  const recentReviews = (activeBranch?.reviews ?? []).slice(0, 3);
  const activeReview = (activeBranch?.reviews ?? []).find((r) => ACTIVE_STATUSES.has(r.status)) ?? null;
  const otherBranches = branches.filter((b) => b.key !== activeBranch?.key);

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-3 py-3">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Review Studio</p>
        <h1 className="policy-heading text-base text-foreground tracking-tight">Home</h1>
      </header>

      {pendingBranchSwitchKey && (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p>
            Branch changed to <span className="font-mono">{pendingBranchSwitchKey.split('/').slice(1).join('/') || pendingBranchSwitchKey}</span>. Switch context?
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => {
                setSelectedBranchKey(pendingBranchSwitchKey);
                setPendingBranchSwitchKey(null);
              }}
            >
              Switch context
            </Button>
          </div>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Current branch context</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{detectedBranchLabel}</p>
            <p className="text-xs text-muted-foreground">{detectedRepoLabel}</p>
            {viewingDifferentContext && (
              <p className="mt-1 text-xs text-amber-700">
                Viewing context: {activeBranch?.branch}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setShowNewReviewPanel(true)}>
              New Review
            </Button>
            {activeReview && (
              <Link to={reviewDestinationPath(activeReview)}>
                <Button size="sm" variant="outline">
                  Resume active review
                </Button>
              </Link>
            )}
          </div>
        </div>
      </Card>

      {showNewReviewPanel && (
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">New Review</h2>
              <p className="mt-1 text-sm text-muted-foreground">Slide-over start flow lands in Slice 2. For now, start from CLI and reopen Studio.</p>
              <p className="mt-2 text-xs font-mono text-foreground/80">nimbus review create --commit HEAD --open-studio</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setShowNewReviewPanel(false)}>
              Close
            </Button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground">Loading home view…</p>
        </div>
      ) : errorMessage ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Unable to load Studio Home</h2>
          <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
        </Card>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Recent reviews (current branch)</h2>
            {recentReviews.length === 0 ? (
              <Card className="p-4">
                <p className="text-sm text-muted-foreground">No reviews on this branch yet.</p>
              </Card>
            ) : (
              <ul className="flex flex-col gap-2">
                {recentReviews.map((entry) => (
                  <li key={entry.id}>
                    <Link to={reviewDestinationPath(entry)}>
                      <Card className="px-3 py-2 transition-colors hover:bg-accent/30">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <StatusPill status={entry.status} />
                            <span className="text-xs font-mono text-muted-foreground">{entry.id}</span>
                            <Badge variant="outline" className="text-[10px] uppercase">
                              {entry.findingCount ?? 0} findings
                            </Badge>
                          </div>
                          <span className="text-xs text-muted-foreground">{relativeTime(entry.createdAt)}</span>
                        </div>
                        {entry.summaryText && (
                          <p className="mt-1 text-sm text-foreground/80">{entry.summaryText}</p>
                        )}
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Branch list</h2>
            {otherBranches.length === 0 ? (
              <Card className="p-3">
                <p className="text-sm text-muted-foreground">No other branch review history yet.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {otherBranches.map((branchGroup) => (
                  <Card key={branchGroup.key} className="px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{branchGroup.branch}</p>
                        <p className="text-xs text-muted-foreground">{branchGroup.repo}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {branchGroup.reviews.length} reviews
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => setSelectedBranchKey(branchGroup.key)}>
                          View in Home
                        </Button>
                        <Link to={`/branches/${encodeURIComponent(branchGroup.repo)}/${encodeURIComponent(branchGroup.branch)}`}>
                          <Button size="sm" variant="ghost">History</Button>
                        </Link>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
