import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

function reviewDestinationPath(entry: ReviewHistoryItem): string {
  const branchBase = `/branches/${encodeURIComponent(entry.repo)}/${encodeURIComponent(entry.branch)}`;
  if (entry.status === 'policy_pending' || entry.status === 'policy_ready' || entry.status === 'policy_approved') {
    return `${branchBase}/policy/${entry.id}`;
  }
  return `${branchBase}/reports/${entry.id}`;
}

export function ReviewHistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [studioContext, setStudioContext] = useState<StudioContextResponse | null>(null);
  const [selectedBranchKey, setSelectedBranchKey] = useState<string | null>(null);
  const [pendingBranchSwitchKey, setPendingBranchSwitchKey] = useState<string | null>(null);
  const [lastDetectedBranchKey, setLastDetectedBranchKey] = useState<string | null>(null);
  const [showNewReviewPanel, setShowNewReviewPanel] = useState(false);
  const [newReviewPolicyMode, setNewReviewPolicyMode] = useState<StudioPolicyMode>('auto');
  const [newReviewPreflight, setNewReviewPreflight] = useState<StudioNewReviewPreflightResponse | null>(null);
  const [newReviewPreflightLoading, setNewReviewPreflightLoading] = useState(false);
  const [newReviewPreflightError, setNewReviewPreflightError] = useState<string | null>(null);
  const [newReviewStarting, setNewReviewStarting] = useState(false);
  const [newReviewStartError, setNewReviewStartError] = useState<string | null>(null);

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

  const activeBranch = selectedBranchKey ? (branches.find((b) => b.key === selectedBranchKey) ?? null) : null;
  const detectedBranchLabel = studioContext?.branch ?? 'unknown';
  const detectedRepoLabel = studioContext?.repo ?? 'repo unavailable';
  const activeReview = (activeBranch?.reviews ?? []).find((r) => ACTIVE_STATUSES.has(r.status)) ?? null;
  const otherBranches = activeBranch ? branches.filter((b) => b.key !== activeBranch.key) : branches;

  const startNewReview = useCallback(async () => {
    setNewReviewStarting(true);
    setNewReviewStartError(null);
    try {
      const response = await fetch(`${API_BASE}/api/studio/new-review/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ policyMode: newReviewPolicyMode }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to start review (${response.status})`);
      }
      const started = parseStudioNewReviewStartResponse(await response.json());
      setShowNewReviewPanel(false);
      navigate(started.routePath);
    } catch (error) {
      setNewReviewStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewReviewStarting(false);
    }
  }, [navigate, newReviewPolicyMode]);

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
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setNewReviewStartError(null);
                setNewReviewPreflightError(null);
                setShowNewReviewPanel(true);
              }}
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
          </div>
        </div>
      </Card>

      {showNewReviewPanel && (
        <Card className="p-4">
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">New Review</h2>
                <p className="mt-1 text-sm text-muted-foreground">Target defaults to latest checkpoint on the current branch.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setShowNewReviewPanel(false)} disabled={newReviewStarting}>
                Close
              </Button>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Policy mode</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setNewReviewPolicyMode('auto')}
                  className={`rounded-sm border px-3 py-2 text-left text-sm ${
                    newReviewPolicyMode === 'auto' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                  }`}
                >
                  <p className="font-medium text-foreground">Auto policy</p>
                  <p className="text-xs text-muted-foreground">Fast path. Policy is approved automatically.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setNewReviewPolicyMode('review')}
                  className={`rounded-sm border px-3 py-2 text-left text-sm ${
                    newReviewPolicyMode === 'review' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                  }`}
                >
                  <p className="font-medium text-foreground">Review policy first</p>
                  <p className="text-xs text-muted-foreground">Pause on policy draft before execution.</p>
                </button>
              </div>
            </div>

            <div className="rounded-sm border border-border bg-muted/20 p-3">
              <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Preflight</p>
              {newReviewPreflightLoading ? (
                <p className="mt-2 text-sm text-muted-foreground">Checking branch, checkpoint, and context…</p>
              ) : newReviewPreflightError ? (
                <p className="mt-2 text-sm text-red-700">{newReviewPreflightError}</p>
              ) : newReviewPreflight ? (
                <div className="mt-2 space-y-2 text-sm">
                  <p className="text-foreground">
                    Branch: <span className="font-mono">{newReviewPreflight.branch ?? 'unknown'}</span>
                  </p>
                  <p className="text-foreground">
                    Checkpoint:{' '}
                    <span className="font-mono">
                      {newReviewPreflight.checkpointId ?? 'unavailable'}
                    </span>
                  </p>
                  <div className="space-y-1">
                    {newReviewPreflight.checks.map((check) => (
                      <p key={check.code} className={check.ok ? 'text-foreground' : 'text-red-700'}>
                        {check.ok ? 'OK' : 'FAIL'} {check.label}: {check.detail}
                      </p>
                    ))}
                  </div>
                  {!newReviewPreflight.ready && newReviewPreflight.error && (
                    <p className="text-red-700">{newReviewPreflight.error.message}</p>
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
                disabled={newReviewStarting || newReviewPreflightLoading || !newReviewPreflight?.ready}
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
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Branch list</h2>
            {otherBranches.length === 0 ? (
              <Card className="p-3">
                <p className="text-sm text-muted-foreground">No other branch review history yet.</p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {otherBranches.map((branchGroup) => (
                  <Link
                    key={branchGroup.key}
                    to={`/branches/${encodeURIComponent(branchGroup.repo)}/${encodeURIComponent(branchGroup.branch)}`}
                    className="block"
                  >
                    <Card className="px-3 py-2 transition-colors hover:bg-accent/30">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-foreground">{branchGroup.branch}</p>
                          <p className="text-xs text-muted-foreground">{branchGroup.repo}</p>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {branchGroup.reviews.length} reviews
                        </Badge>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
