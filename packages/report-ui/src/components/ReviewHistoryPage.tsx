import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CompactHistoryText } from './CompactHistoryText';
import {
  parseListReviewsResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartResponse,
} from '../lib/review';
import type {
  ListReviewsResponse,
  ReviewHistoryItem,
  ReviewStatus,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioPolicyMode,
} from '../types';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 30_000;
const BRANCH_CONTEXT_POLL_MS = 10_000;
const ACTIVE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

interface StudioBranchRef {
  repo: string;
  branch: string;
}

interface BranchGroup extends StudioBranchRef {
  key: string;
  reviews: ReviewHistoryItem[];
}

function toStudioBranchRef(input: { repo: string | null; branch: string | null } | null | undefined): StudioBranchRef | null {
  if (!input?.repo || !input.branch) {
    return null;
  }
  return {
    repo: input.repo,
    branch: input.branch,
  };
}

function branchRefKey(branch: StudioBranchRef): string {
  return `${branch.repo}\u0000${branch.branch}`;
}

function sameBranchRef(left: StudioBranchRef | null, right: StudioBranchRef | null): boolean {
  return Boolean(left && right && left.repo === right.repo && left.branch === right.branch);
}

function reviewDestinationPath(entry: ReviewHistoryItem): string {
  const branchBase = `/branches/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.branch)}`;
  if (entry.status === 'policy_pending' || entry.status === 'policy_ready' || entry.status === 'policy_approved') {
    return `${branchBase}/policy/${entry.id}`;
  }
  return `${branchBase}/reports/${entry.id}`;
}

function branchDestinationPath(repo: string, branch: string): string {
  return `/branches/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}`;
}

function relativeTime(timestamp: string | null): string {
  if (!timestamp) {
    return 'unknown';
  }
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

function branchSummary(group: BranchGroup): string {
  const latest = group.reviews[0];
  if (!latest) {
    return 'No reviews yet.';
  }
  return latest.summaryText?.trim() || `Latest review ${latest.id}`;
}

export function ReviewHistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [studioContext, setStudioContext] = useState<StudioContextResponse | null>(null);
  const [homeBranch, setHomeBranch] = useState<StudioBranchRef | null>(null);
  const [pendingBranchSwitch, setPendingBranchSwitch] = useState<StudioBranchRef | null>(null);
  const [lastDetectedBranch, setLastDetectedBranch] = useState<StudioBranchRef | null>(null);
  const [showNewReviewPanel, setShowNewReviewPanel] = useState(false);
  const [newReviewPolicyMode, setNewReviewPolicyMode] = useState<StudioPolicyMode>('auto');
  const [newReviewPreflight, setNewReviewPreflight] = useState<StudioNewReviewPreflightResponse | null>(null);
  const [newReviewPreflightLoading, setNewReviewPreflightLoading] = useState(false);
  const [newReviewPreflightError, setNewReviewPreflightError] = useState<string | null>(null);
  const [newReviewStarting, setNewReviewStarting] = useState(false);
  const [newReviewStartError, setNewReviewStartError] = useState<string | null>(null);

  const detectedBranch = useMemo(() => toStudioBranchRef(studioContext), [studioContext]);

  const closeNewReviewPanel = useCallback(() => {
    setShowNewReviewPanel(false);
    setNewReviewPreflight(null);
    setNewReviewPreflightError(null);
    setNewReviewStartError(null);
  }, []);

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

  const fetchNewReviewPreflight = useCallback(async () => {
    setNewReviewPreflightLoading(true);
    setNewReviewPreflightError(null);
    try {
      const response = await fetch(`${API_BASE}/api/studio/new-review/preflight`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to load review preflight (${response.status})`);
      }
      const payload = parseStudioNewReviewPreflightResponse(await response.json());
      setNewReviewPreflight(payload);
      setNewReviewPolicyMode(payload.policyMode);
    } catch (error) {
      setNewReviewPreflight(null);
      setNewReviewPreflightError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewReviewPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detectedBranch) {
      return;
    }
    if (!homeBranch) {
      setHomeBranch(detectedBranch);
    }
    if (!lastDetectedBranch) {
      setLastDetectedBranch(detectedBranch);
      return;
    }
    if (!sameBranchRef(detectedBranch, lastDetectedBranch)) {
      if (homeBranch && !sameBranchRef(detectedBranch, homeBranch)) {
        setPendingBranchSwitch(detectedBranch);
        if (showNewReviewPanel) {
          closeNewReviewPanel();
        }
      } else {
        setPendingBranchSwitch(null);
      }
      setLastDetectedBranch(detectedBranch);
      return;
    }
    if (pendingBranchSwitch && homeBranch && sameBranchRef(detectedBranch, homeBranch)) {
      setPendingBranchSwitch(null);
    }
  }, [closeNewReviewPanel, detectedBranch, homeBranch, lastDetectedBranch, pendingBranchSwitch, showNewReviewPanel]);

  useEffect(() => {
    let cancelled = false;
    const canRefresh = () => !cancelled && document.visibilityState === 'visible';
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
      if (!canRefresh()) {
        return;
      }
      void fetchReviews().catch((error) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });
    }, REVIEW_LIST_POLL_MS);
    const branchTimer = window.setInterval(() => {
      if (!canRefresh()) {
        return;
      }
      void fetchStudioContext().catch(() => undefined);
    }, BRANCH_CONTEXT_POLL_MS);
    const onVisibilityChange = () => {
      if (!canRefresh()) {
        return;
      }
      void Promise.all([fetchReviews(), fetchStudioContext()]).catch((error) => {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        }
      });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(reviewTimer);
      window.clearInterval(branchTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchReviews, fetchStudioContext]);

  useEffect(() => {
    if (!showNewReviewPanel) {
      return;
    }
    void fetchNewReviewPreflight();
  }, [showNewReviewPanel, fetchNewReviewPreflight]);

  const branches = useMemo((): BranchGroup[] => {
    const sorted = [...entries].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime() || 0;
      const bTime = new Date(b.createdAt).getTime() || 0;
      return bTime - aTime;
    });
    const map = new Map<string, BranchGroup>();
    for (const entry of sorted) {
      const ref = { repo: entry.repo, branch: entry.branch };
      const key = branchRefKey(ref);
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

  const homeBranchKey = homeBranch ? branchRefKey(homeBranch) : null;
  const homeBranchGroup = homeBranchKey ? (branches.find((branchGroup) => branchGroup.key === homeBranchKey) ?? null) : null;
  const homeBranchReviews = homeBranchGroup?.reviews ?? [];
  const recentHomeReviews = homeBranchReviews.slice(0, 3);
  const activeReview = homeBranchReviews.find((review) => ACTIVE_STATUSES.has(review.status)) ?? null;
  const latestHomeReview = homeBranchReviews[0] ?? null;
  const otherBranches = homeBranchKey ? branches.filter((branchGroup) => branchGroup.key !== homeBranchKey) : branches;
  const homeBranchPath = homeBranch ? branchDestinationPath(homeBranch.repo, homeBranch.branch) : null;
  const canStartNewReview = Boolean(homeBranch && detectedBranch && sameBranchRef(homeBranch, detectedBranch) && !pendingBranchSwitch);

  const startNewReview = useCallback(async () => {
    if (!homeBranch) {
      return;
    }
    setNewReviewStarting(true);
    setNewReviewStartError(null);
    try {
      const response = await fetch(`${API_BASE}/api/studio/new-review/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          policyMode: newReviewPolicyMode,
          repo: homeBranch.repo,
          branch: homeBranch.branch,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to start review (${response.status})`);
      }
      const started = parseStudioNewReviewStartResponse(await response.json());
      closeNewReviewPanel();
      navigate(started.routePath);
    } catch (error) {
      setNewReviewStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewReviewStarting(false);
    }
  }, [closeNewReviewPanel, homeBranch, navigate, newReviewPolicyMode]);

  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-3 px-3 py-3">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Review Studio</p>
        <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="policy-heading text-base text-foreground tracking-tight">Home</h1>
            <p className="text-sm text-muted-foreground">
              Start from the branch you intend to review, then browse other branch history without changing that target.
            </p>
          </div>
        </div>
      </header>

      {pendingBranchSwitch && (
        <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <p>
            Working branch changed to <span className="font-mono">{pendingBranchSwitch.branch}</span>. Switch Home before starting another review so the target stays explicit.
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              onClick={() => {
                setHomeBranch(pendingBranchSwitch);
                setPendingBranchSwitch(null);
              }}
            >
              Switch Home to {pendingBranchSwitch.branch}
            </Button>
          </div>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1.5">
              <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Home branch</p>
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                {homeBranch?.branch ?? detectedBranch?.branch ?? 'Branch unavailable'}
              </h2>
              <p className="text-sm text-muted-foreground">{homeBranch?.repo ?? detectedBranch?.repo ?? 'Repo unavailable'}</p>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {pendingBranchSwitch
                  ? `Home is still focused on ${homeBranch?.branch ?? 'the previous branch'}. Resume history here if needed, or switch before starting a new review.`
                  : 'New Review and Resume active review both target this branch.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button
                size="sm"
                onClick={() => {
                  setNewReviewStartError(null);
                  setNewReviewPreflightError(null);
                  setShowNewReviewPanel(true);
                }}
                disabled={!canStartNewReview}
              >
                New Review
              </Button>
              {activeReview && (
                <Link to={reviewDestinationPath(activeReview)}>
                  <Button size="sm" variant="outline">
                    Resume active review
                  </Button>
                </Link>
              )}
              {homeBranchPath && (
                <Link to={homeBranchPath}>
                  <Button size="sm" variant="ghost">
                    View branch history
                  </Button>
                </Link>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2.5">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Active review</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">
                {activeReview ? activeReview.id : 'None on this branch'}
              </dd>
            </div>
            <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2.5">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Recent reviews</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">{homeBranchReviews.length}</dd>
            </div>
            <div className="rounded-sm border border-border/70 bg-card/70 px-3 py-2.5">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Latest update</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground">{relativeTime(latestHomeReview?.updatedAt ?? latestHomeReview?.createdAt ?? null)}</dd>
            </div>
          </dl>
        </div>
      </Card>

      {showNewReviewPanel && (
        <Card className="p-4">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Start review</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Nimbus will review the latest checkpoint on <span className="font-mono text-foreground">{homeBranch?.branch ?? detectedBranch?.branch ?? 'this branch'}</span>.
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={closeNewReviewPanel} disabled={newReviewStarting}>
                Close
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Policy mode</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setNewReviewPolicyMode('auto')}
                  className={`rounded-sm border px-3 py-3 text-left text-sm ${
                    newReviewPolicyMode === 'auto' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                  }`}
                >
                  <p className="font-medium text-foreground">Auto policy</p>
                  <p className="mt-1 text-xs text-muted-foreground">Derive and approve policy automatically, then queue the review.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setNewReviewPolicyMode('review')}
                  className={`rounded-sm border px-3 py-3 text-left text-sm ${
                    newReviewPolicyMode === 'review' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                  }`}
                >
                  <p className="font-medium text-foreground">Review policy first</p>
                  <p className="mt-1 text-xs text-muted-foreground">Pause on the derived policy so you can review or edit it before execution.</p>
                </button>
              </div>
            </div>

            <div className="rounded-sm border border-border bg-muted/20 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Preflight</p>
                <p className="text-xs text-muted-foreground">Action target must match the Home branch above.</p>
              </div>
              {newReviewPreflightLoading ? (
                <p className="mt-2 text-sm text-muted-foreground">Checking branch, checkpoint, and context…</p>
              ) : newReviewPreflightError ? (
                <p className="mt-2 text-sm text-red-700">{newReviewPreflightError}</p>
              ) : newReviewPreflight ? (
                <div className="mt-3 space-y-3 text-sm">
                  <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Branch</dt>
                      <dd className="mt-1 font-mono text-foreground">{newReviewPreflight.branch ?? 'unknown'}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Checkpoint</dt>
                      <dd className="mt-1 font-mono text-foreground">{newReviewPreflight.checkpointId ?? 'unavailable'}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Policy mode</dt>
                      <dd className="mt-1 text-foreground">{newReviewPolicyMode === 'auto' ? 'Auto policy' : 'Review policy first'}</dd>
                    </div>
                  </dl>
                  <div className="space-y-2">
                    {newReviewPreflight.checks.map((check) => (
                      <div key={check.code} className="rounded-sm border border-border/70 bg-card/80 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-foreground">{check.label}</p>
                          <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]">
                            {check.ok ? 'Ready' : 'Blocked'}
                          </Badge>
                        </div>
                        <p className={`mt-1 text-sm ${check.ok ? 'text-muted-foreground' : 'text-red-700'}`}>{check.detail}</p>
                      </div>
                    ))}
                  </div>
                  {!newReviewPreflight.ready && newReviewPreflight.error && (
                    <p className="text-sm text-red-700">{newReviewPreflight.error.message}</p>
                  )}
                </div>
              ) : null}
            </div>

            {newReviewStartError && <p className="text-sm text-red-700">{newReviewStartError}</p>}

            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => void fetchNewReviewPreflight()} disabled={newReviewStarting}>
                Refresh preflight
              </Button>
              <Button
                size="sm"
                onClick={() => void startNewReview()}
                disabled={newReviewStarting || newReviewPreflightLoading || !newReviewPreflight?.ready || !canStartNewReview}
              >
                {newReviewStarting ? 'Starting…' : 'Start Review'}
              </Button>
            </div>
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
          {recentHomeReviews.length > 0 ? (
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Recent on this branch</h2>
                  <p className="text-sm text-muted-foreground">Keep momentum on the branch Home is currently targeting.</p>
                </div>
                {homeBranchPath && (
                  <Link to={homeBranchPath} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                    Open full history
                  </Link>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                {recentHomeReviews.map((entry) => (
                  <Link key={entry.id} to={reviewDestinationPath(entry)} className="block">
                    <Card className="h-full px-3 py-3 transition-colors hover:bg-accent/30">
                      <div className="flex items-start justify-between gap-2">
                        <StatusPill status={entry.status} />
                        <span className="text-xs text-muted-foreground">{relativeTime(entry.updatedAt || entry.createdAt)}</span>
                      </div>
                      <CompactHistoryText className="mt-2 text-sm text-foreground/85" text={entry.summaryText ?? entry.id} />
                      <p className="mt-2 text-[11px] text-muted-foreground font-mono">{entry.id}</p>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ) : (
            <Card className="p-3">
              <p className="text-sm text-muted-foreground">
                No reviews on this branch yet. Start one from the current Home branch when you are ready.
              </p>
            </Card>
          )}

          <section className="space-y-2">
            <div>
              <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Browse other branches</h2>
              <p className="text-sm text-muted-foreground">History only. New reviews still start from the Home branch above.</p>
            </div>
            {otherBranches.length === 0 ? (
              <Card className="p-3">
                <p className="text-sm text-muted-foreground">No other branch review history yet.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {otherBranches.map((branchGroup) => {
                  const latest = branchGroup.reviews[0];
                  const hasActive = branchGroup.reviews.some((review) => ACTIVE_STATUSES.has(review.status));
                  return (
                    <Link
                      key={branchGroup.key}
                      to={branchDestinationPath(branchGroup.repo, branchGroup.branch)}
                      className="block"
                    >
                      <Card className="h-full px-3 py-3 transition-colors hover:bg-accent/30">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-foreground">{branchGroup.branch}</p>
                              {hasActive && (
                                <Badge variant="outline" className="rounded-full border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-blue-800">
                                  Active
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{branchGroup.repo}</p>
                          </div>
                          <span className="text-xs text-muted-foreground">{latest ? relativeTime(latest.updatedAt || latest.createdAt) : 'unknown'}</span>
                        </div>
                        <CompactHistoryText className="mt-2 text-sm text-foreground/80" text={branchSummary(branchGroup)} />
                        <p className="mt-2 text-xs text-muted-foreground">
                          {branchGroup.reviews.length} review{branchGroup.reviews.length === 1 ? '' : 's'}
                        </p>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
