import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { CompactHistoryText } from './CompactHistoryText';
import {
  parseListReviewsResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartResponse,
  parseStudioNewReviewStartStreamEvent,
} from '../lib/review';
import type {
  ListReviewsResponse,
  ReviewHistoryItem,
  ReviewStatus,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartStageEvent,
  StudioPolicyMode,
} from '../types';
import { StatusPill } from './ui/StatusPill';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const REVIEW_LIST_POLL_MS = 30_000;
const BRANCH_CONTEXT_POLL_MS = 10_000;
const STUDIO_NEW_REVIEW_START_EVENTS_PATH = '/api/studio/new-review/start/events';
const ACTIVE_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'policy_pending',
  'policy_ready',
  'policy_approved',
  'queued',
  'running',
]);

const PANEL_TRANSITION = {
  duration: 0.22,
  ease: [0.215, 0.61, 0.355, 1],
} as const;

const PREFLIGHT_LOADING_STEPS = [
  {
    id: 'checkpoint',
    label: 'Resolving checkpoint',
    detail: 'Matching the Home branch to the latest checkpoint context.',
  },
  {
    id: 'session',
    label: 'Reading session context',
    detail: 'Checking that Entire session metadata is available and readable.',
  },
  {
    id: 'related',
    label: 'Loading related context',
    detail: 'Scanning recent checkpoints for nearby files and branch context.',
  },
  {
    id: 'target',
    label: 'Validating review target',
    detail: 'Confirming the Home branch is still the action target before start.',
  },
] as const;

const START_STAGE_ORDER = [
  'checkpoint',
  'entire_context',
  'cochange',
  'workspace',
  'deployment',
  'review_creation',
  'policy',
] as const;

interface StudioBranchRef {
  repo: string;
  branch: string;
}

interface BranchGroup extends StudioBranchRef {
  key: string;
  reviews: ReviewHistoryItem[];
}

type AnimatedPreflightStepState = 'pending' | 'active' | 'complete';

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

function preflightLoadingState(index: number, activeIndex: number): AnimatedPreflightStepState {
  if (index < activeIndex) {
    return 'complete';
  }
  if (index === activeIndex) {
    return 'active';
  }
  return 'pending';
}

function preflightLoadingClass(state: AnimatedPreflightStepState): string {
  if (state === 'complete') {
    return 'border-emerald-200 bg-emerald-50/80 text-emerald-900';
  }
  if (state === 'active') {
    return 'border-sky-200 bg-sky-50/80 text-sky-900';
  }
  return 'border-border/70 bg-card/70 text-muted-foreground';
}

function startStageClass(state: StudioNewReviewStartStageEvent['state']): string {
  if (state === 'completed') {
    return 'border-emerald-200 bg-emerald-50/80 text-emerald-900';
  }
  return 'border-sky-200 bg-sky-50/80 text-sky-900';
}

function sortStartStages(stages: StudioNewReviewStartStageEvent[]): StudioNewReviewStartStageEvent[] {
  return [...stages].sort(
    (left, right) => START_STAGE_ORDER.indexOf(left.stage) - START_STAGE_ORDER.indexOf(right.stage)
  );
}

function startStageStatusLabel(state: StudioNewReviewStartStageEvent['state']): string {
  return state === 'completed' ? 'Done' : 'Working';
}

export function ReviewHistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const startStreamRef = useRef<EventSource | null>(null);
  const [entries, setEntries] = useState<ReviewHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [studioContext, setStudioContext] = useState<StudioContextResponse | null>(null);
  const [homeBranch, setHomeBranch] = useState<StudioBranchRef | null>(null);
  const [pendingBranchSwitch, setPendingBranchSwitch] = useState<StudioBranchRef | null>(null);
  const [lastDetectedBranch, setLastDetectedBranch] = useState<StudioBranchRef | null>(null);
  const [showNewReviewPanel, setShowNewReviewPanel] = useState(false);
  const [newReviewPolicyMode, setNewReviewPolicyMode] = useState<StudioPolicyMode>('auto');
  const [newReviewCheckpointCount, setNewReviewCheckpointCount] = useState<1 | 2 | 3>(2);
  const [newReviewPreflight, setNewReviewPreflight] = useState<StudioNewReviewPreflightResponse | null>(null);
  const [newReviewPreflightLoading, setNewReviewPreflightLoading] = useState(false);
  const [newReviewPreflightError, setNewReviewPreflightError] = useState<string | null>(null);
  const [newReviewStarting, setNewReviewStarting] = useState(false);
  const [newReviewStartError, setNewReviewStartError] = useState<string | null>(null);
  const [newReviewStartStages, setNewReviewStartStages] = useState<StudioNewReviewStartStageEvent[]>([]);
  const [preflightLoadingStepIndex, setPreflightLoadingStepIndex] = useState(0);
  const [showPreflightDetails, setShowPreflightDetails] = useState(false);
  const [editingPolicyMode, setEditingPolicyMode] = useState(false);

  const detectedBranch = useMemo(() => toStudioBranchRef(studioContext), [studioContext]);

  const closeStartStream = useCallback(() => {
    startStreamRef.current?.close();
    startStreamRef.current = null;
  }, []);

  const closeNewReviewPanel = useCallback(() => {
    closeStartStream();
    setShowNewReviewPanel(false);
    setNewReviewPreflight(null);
    setNewReviewPreflightError(null);
    setNewReviewStartError(null);
    setNewReviewStartStages([]);
    setShowPreflightDetails(false);
    setEditingPolicyMode(false);
  }, [closeStartStream]);

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
      const params = new URLSearchParams({
        lastCheckpoints: String(newReviewCheckpointCount),
      });
      const response = await fetch(`${API_BASE}/api/studio/new-review/preflight?${params.toString()}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to load review preflight (${response.status})`);
      }
      const payload = parseStudioNewReviewPreflightResponse(await response.json());
      setNewReviewPreflight(payload);
      setNewReviewPolicyMode(payload.policyMode);
      setNewReviewCheckpointCount(payload.lastCheckpoints);
      setShowPreflightDetails(false);
      setEditingPolicyMode(false);
    } catch (error) {
      setNewReviewPreflight(null);
      setNewReviewPreflightError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewReviewPreflightLoading(false);
    }
  }, [newReviewCheckpointCount]);

  useEffect(() => {
    return () => {
      closeStartStream();
    };
  }, [closeStartStream]);

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
  }, [showNewReviewPanel, fetchNewReviewPreflight, newReviewCheckpointCount]);

  useEffect(() => {
    if (!showNewReviewPanel || !newReviewPreflightLoading) {
      setPreflightLoadingStepIndex(0);
      return;
    }

    const timer = window.setInterval(() => {
      setPreflightLoadingStepIndex((current) =>
        current >= PREFLIGHT_LOADING_STEPS.length - 1 ? 0 : current + 1
      );
    }, 900);

    return () => {
      window.clearInterval(timer);
    };
  }, [newReviewPreflightLoading, showNewReviewPanel]);

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
  const preflightReady = Boolean(newReviewPreflight?.ready);
  const showExpandedPolicyMode = !preflightReady || editingPolicyMode;
  const activeStartStage = newReviewStartStages.find((stage) => stage.state === 'active') ?? null;
  const completedStartStages = newReviewStartStages.filter((stage) => stage.state === 'completed');
  const latestCompletedStartStage = completedStartStages[completedStartStages.length - 1] ?? null;
  const startProgressCount = Math.max(completedStartStages.length + (activeStartStage ? 1 : 0), 1);
  const startProgressRatio = Math.min(1, startProgressCount / START_STAGE_ORDER.length);

  const startNewReview = useCallback(async () => {
    if (!homeBranch) {
      return;
    }
    setNewReviewStarting(true);
    setNewReviewStartError(null);
    setNewReviewStartStages([]);
    closeStartStream();

    if (typeof EventSource !== 'undefined') {
      const params = new URLSearchParams({
        policyMode: newReviewPolicyMode,
        lastCheckpoints: String(newReviewCheckpointCount),
        repo: homeBranch.repo,
        branch: homeBranch.branch,
      });
      const stream = new EventSource(`${API_BASE}${STUDIO_NEW_REVIEW_START_EVENTS_PATH}?${params.toString()}`);
      startStreamRef.current = stream;

      stream.addEventListener('message', (event: MessageEvent<string>) => {
        try {
          const payload = parseStudioNewReviewStartStreamEvent(JSON.parse(event.data));
          if (payload.type === 'stage') {
            setNewReviewStartStages((current) => {
              const next = current.filter((item) => item.stage !== payload.stage);
              next.push(payload);
              return sortStartStages(next);
            });
            return;
          }

          if (payload.type === 'completed') {
            closeStartStream();
            closeNewReviewPanel();
            navigate(payload.routePath);
            return;
          }

          closeStartStream();
          setNewReviewStartError(payload.message);
          setNewReviewStarting(false);
        } catch (error) {
          closeStartStream();
          setNewReviewStartError(error instanceof Error ? error.message : String(error));
          setNewReviewStarting(false);
        }
      });

      stream.addEventListener('error', () => {
        closeStartStream();
        setNewReviewStartError('Studio start stream was interrupted before the review route was ready.');
        setNewReviewStarting(false);
      });
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/studio/new-review/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          policyMode: newReviewPolicyMode,
          lastCheckpoints: newReviewCheckpointCount,
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
  }, [
    closeNewReviewPanel,
    closeStartStream,
    homeBranch,
    navigate,
    newReviewCheckpointCount,
    newReviewPolicyMode,
  ]);

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

      <AnimatePresence initial={false}>
        {showNewReviewPanel && (
          <motion.div
            key="new-review-panel"
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.99 }}
            transition={PANEL_TRANSITION}
            layout
          >
            <Card className="overflow-hidden p-4">
              <motion.div
                className="space-y-4"
                initial="hidden"
                animate="visible"
                exit="hidden"
                variants={{
                  hidden: {},
                  visible: {
                    transition: {
                      staggerChildren: 0.05,
                      delayChildren: 0.02,
                    },
                  },
                }}
              >
                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 10 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={PANEL_TRANSITION}
                  className="flex items-start justify-between gap-3"
                >
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">Start review</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Nimbus will review up to {newReviewCheckpointCount} checkpoint{newReviewCheckpointCount === 1 ? '' : 's'} on{' '}
                      <span className="font-mono text-foreground">{homeBranch?.branch ?? detectedBranch?.branch ?? 'this branch'}</span>.
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={closeNewReviewPanel} disabled={newReviewStarting}>
                    Close
                  </Button>
                </motion.div>

                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 10 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={PANEL_TRANSITION}
                  className="space-y-2"
                >
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Checkpoint window</p>
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3].map((count) => {
                      const active = newReviewCheckpointCount === count;
                      return (
                        <button
                          key={count}
                          type="button"
                          onClick={() => setNewReviewCheckpointCount(count as 1 | 2 | 3)}
                          className={`rounded-sm border px-3 py-2 text-left text-sm transition-colors ${
                            active ? 'border-primary bg-accent/30' : 'border-border bg-background'
                          }`}
                        >
                          <p className="font-medium text-foreground">Last {count}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">checkpoint{count === 1 ? '' : 's'}</p>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>

                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 10 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={PANEL_TRANSITION}
                  className="space-y-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Policy mode</p>
                    {preflightReady && !showExpandedPolicyMode ? (
                      <button
                        type="button"
                        onClick={() => setEditingPolicyMode(true)}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Change
                      </button>
                    ) : null}
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    {showExpandedPolicyMode ? (
                      <motion.div
                        key="policy-expanded"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={PANEL_TRANSITION}
                        className="grid grid-cols-1 gap-2 md:grid-cols-2"
                      >
                        <button
                          type="button"
                          onClick={() => setNewReviewPolicyMode('auto')}
                          className={`rounded-sm border px-3 py-3 text-left text-sm transition-colors ${
                            newReviewPolicyMode === 'auto' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                          }`}
                        >
                          <p className="font-medium text-foreground">Auto policy</p>
                          <p className="mt-1 text-xs text-muted-foreground">Derive and approve policy automatically, then queue the review.</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewReviewPolicyMode('review')}
                          className={`rounded-sm border px-3 py-3 text-left text-sm transition-colors ${
                            newReviewPolicyMode === 'review' ? 'border-primary bg-accent/30' : 'border-border bg-background'
                          }`}
                        >
                          <p className="font-medium text-foreground">Review policy first</p>
                          <p className="mt-1 text-xs text-muted-foreground">Pause on the derived policy so you can review or edit it before execution.</p>
                        </button>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="policy-collapsed"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={PANEL_TRANSITION}
                        className="rounded-sm border border-border/70 bg-card/75 px-3 py-2.5"
                      >
                        <p className="text-sm font-medium text-foreground">
                          {newReviewPolicyMode === 'auto' ? 'Auto policy' : 'Review policy first'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {newReviewPolicyMode === 'auto'
                            ? 'Nimbus will derive the policy and continue automatically.'
                            : 'Nimbus will pause on the policy before running the review.'}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 10 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={PANEL_TRANSITION}
                  className="rounded-sm border border-border bg-muted/20 p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Preflight</p>
                    <p className="text-xs text-muted-foreground">Action target must match the Home branch above.</p>
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    {newReviewPreflightLoading ? (
                      <motion.div
                        key="preflight-loading"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={PANEL_TRANSITION}
                        className="mt-3 space-y-3"
                      >
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">Preparing review target…</p>
                          <p className="text-sm text-muted-foreground">
                            Nimbus is collecting the branch context before you commit to the review.
                          </p>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                          <motion.div
                            className="h-full rounded-full bg-foreground/80"
                            initial={{ x: '-35%' }}
                            animate={{ x: ['-35%', '135%'] }}
                            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                            style={{ width: '35%' }}
                          />
                        </div>
                        <div className="space-y-2">
                          {PREFLIGHT_LOADING_STEPS.map((step, index) => {
                            const state = preflightLoadingState(index, preflightLoadingStepIndex);
                            return (
                              <motion.div
                                key={step.id}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...PANEL_TRANSITION, delay: index * 0.04 }}
                                className={`rounded-sm border px-3 py-2 ${preflightLoadingClass(state)}`}
                              >
                                <div className="flex items-center gap-3">
                                  <motion.span
                                    className={`inline-flex h-2.5 w-2.5 rounded-full ${
                                      state === 'complete'
                                        ? 'bg-emerald-500'
                                        : state === 'active'
                                          ? 'bg-sky-500'
                                          : 'bg-border'
                                    }`}
                                    animate={
                                      state === 'active'
                                        ? { scale: [1, 1.35, 1], opacity: [0.85, 1, 0.85] }
                                        : { scale: 1, opacity: 1 }
                                    }
                                    transition={
                                      state === 'active'
                                        ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' }
                                        : { duration: 0.2 }
                                    }
                                  />
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium">{step.label}</p>
                                    <p className="mt-0.5 text-xs opacity-80">{step.detail}</p>
                                  </div>
                                  <span className="ml-auto text-[11px] uppercase tracking-[0.08em]">
                                    {state === 'complete' ? 'Done' : state === 'active' ? 'Working' : 'Queued'}
                                  </span>
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                      </motion.div>
                    ) : newReviewPreflightError ? (
                      <motion.p
                        key="preflight-error"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={PANEL_TRANSITION}
                        className="mt-2 text-sm text-red-700"
                      >
                        {newReviewPreflightError}
                      </motion.p>
                    ) : newReviewPreflight ? (
                      <motion.div
                        key="preflight-ready"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={PANEL_TRANSITION}
                        className="mt-3 space-y-3 text-sm"
                      >
                        {newReviewPreflight.ready ? (
                          <div className="space-y-3">
                            <div className="rounded-sm border border-emerald-200 bg-emerald-50/75 px-3 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-sm font-semibold text-emerald-950">Ready for review</p>
                                  <p className="mt-1 text-sm text-emerald-900/90">
                                    Checkpoint resolved and context is ready for this branch.
                                  </p>
                                </div>
                                <Badge
                                  variant="outline"
                                  className="rounded-full border-emerald-200 bg-white/75 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-emerald-900"
                                >
                                  Ready
                                </Badge>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] font-mono">
                                  {newReviewPreflight.branch ?? 'unknown branch'}
                                </Badge>
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] font-mono">
                                  {newReviewPreflight.checkpointId ?? 'checkpoint unavailable'}
                                </Badge>
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                                  Last {newReviewCheckpointCount} checkpoint{newReviewCheckpointCount === 1 ? '' : 's'}
                                </Badge>
                                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                                  {newReviewPolicyMode === 'auto' ? 'Auto policy' : 'Review policy first'}
                                </Badge>
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs text-muted-foreground">Technical checks are available if you need to verify the setup.</p>
                              <button
                                type="button"
                                onClick={() => setShowPreflightDetails((current) => !current)}
                                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                              >
                                {showPreflightDetails ? 'Hide technical details' : 'View technical details'}
                              </button>
                            </div>

                            <AnimatePresence initial={false}>
                              {showPreflightDetails && (
                                <motion.div
                                  key="preflight-details"
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  transition={PANEL_TRANSITION}
                                  className="overflow-hidden"
                                >
                                  <div className="space-y-2 pt-1">
                                    {newReviewPreflight.checks.map((check, index) => (
                                      <motion.div
                                        key={check.code}
                                        initial={{ opacity: 0, y: 8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ ...PANEL_TRANSITION, delay: index * 0.04 }}
                                        className="rounded-sm border border-border/70 bg-card/80 px-3 py-2"
                                      >
                                        <div className="flex items-center justify-between gap-3">
                                          <p className="text-sm font-medium text-foreground">{check.label}</p>
                                          <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]">
                                            {check.ok ? 'Ready' : 'Blocked'}
                                          </Badge>
                                        </div>
                                        <p className={`mt-1 text-sm ${check.ok ? 'text-muted-foreground' : 'text-red-700'}`}>{check.detail}</p>
                                      </motion.div>
                                    ))}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {newReviewPreflight.checks.map((check, index) => (
                              <motion.div
                                key={check.code}
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ ...PANEL_TRANSITION, delay: index * 0.04 }}
                                className="rounded-sm border border-border/70 bg-card/80 px-3 py-2"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <p className="text-sm font-medium text-foreground">{check.label}</p>
                                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]">
                                    {check.ok ? 'Ready' : 'Blocked'}
                                  </Badge>
                                </div>
                                <p className={`mt-1 text-sm ${check.ok ? 'text-muted-foreground' : 'text-red-700'}`}>{check.detail}</p>
                              </motion.div>
                            ))}
                            {newReviewPreflight.error && (
                              <p className="text-sm text-red-700">{newReviewPreflight.error.message}</p>
                            )}
                          </div>
                        )}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>

                <AnimatePresence initial={false}>
                  {newReviewStartError && (
                    <motion.p
                      key="start-error"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={PANEL_TRANSITION}
                      className="text-sm text-red-700"
                    >
                      {newReviewStartError}
                    </motion.p>
                  )}
                </AnimatePresence>

                <AnimatePresence initial={false}>
                  {newReviewStarting && (
                    <motion.div
                      key="start-progress"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={PANEL_TRANSITION}
                      className="overflow-hidden rounded-sm border border-sky-200 bg-[linear-gradient(135deg,rgba(232,244,255,0.96),rgba(248,251,255,0.98))] p-3"
                    >
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <motion.span
                              className="inline-flex h-2.5 w-2.5 rounded-full bg-sky-500"
                              animate={{ scale: [1, 1.35, 1], opacity: [0.85, 1, 0.85] }}
                              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                            />
                            <p className="text-sm font-semibold text-sky-950">Starting review…</p>
                          </div>
                          <p className="text-sm text-sky-900/90">
                            Nimbus is preparing the review and will open the live results page as soon as the run is ready.
                          </p>
                        </div>
                        <div className="rounded-full border border-sky-200 bg-white/75 px-3 py-1 text-xs uppercase tracking-[0.08em] text-sky-900">
                          Step {Math.min(startProgressCount, START_STAGE_ORDER.length)} of {START_STAGE_ORDER.length}
                        </div>
                      </div>

                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sky-100">
                        <motion.div
                          className="h-full rounded-full bg-sky-500"
                          animate={{ width: `${Math.max(startProgressRatio * 100, 12)}%` }}
                          transition={{ duration: 0.28, ease: [0.215, 0.61, 0.355, 1] }}
                        />
                      </div>

                      <div className="mt-3 space-y-3">
                        {newReviewStartStages.length === 0 ? (
                          <div className="rounded-sm border border-sky-200/80 bg-white/70 px-3 py-2 text-sm text-sky-900">
                            Establishing the review start stream…
                          </div>
                        ) : (
                          <>
                            <motion.div
                              key={`${activeStartStage?.stage ?? 'completed'}-${activeStartStage?.state ?? 'completed'}`}
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={PANEL_TRANSITION}
                              className={`rounded-sm border px-3 py-3 ${startStageClass(activeStartStage?.state ?? 'completed')}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[11px] uppercase tracking-[0.08em] opacity-75">Current step</p>
                                  <p className="mt-1 text-sm font-semibold">
                                    {activeStartStage?.label ?? latestCompletedStartStage?.label ?? 'Preparing review'}
                                  </p>
                                  <p className="mt-1 text-sm opacity-85">
                                    {activeStartStage?.detail ??
                                      latestCompletedStartStage?.detail ??
                                      'Nimbus is preparing the review handoff.'}
                                  </p>
                                </div>
                                <span className="shrink-0 rounded-full border border-current/20 bg-white/60 px-2 py-0.5 text-[11px] uppercase tracking-[0.08em]">
                                  {startStageStatusLabel(activeStartStage?.state ?? 'completed')}
                                </span>
                              </div>
                            </motion.div>

                            {completedStartStages.length > 0 && (
                              <div className="space-y-2">
                                <p className="text-[11px] uppercase tracking-[0.08em] text-sky-900/65">Completed</p>
                                <div className="flex flex-wrap gap-2">
                                  {completedStartStages.map((stage, index) => (
                                    <motion.span
                                      key={`${stage.stage}-${stage.state}`}
                                      initial={{ opacity: 0, y: 6 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      transition={{ ...PANEL_TRANSITION, delay: index * 0.03 }}
                                      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-emerald-900"
                                    >
                                      <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                      {stage.label}
                                    </motion.span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 10 },
                    visible: { opacity: 1, y: 0 },
                  }}
                  transition={PANEL_TRANSITION}
                  className="flex items-center justify-end gap-2"
                >
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
                </motion.div>
              </motion.div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

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
