import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseGetReviewResponse } from '../lib/review';
import type { GetReviewResponse, ReviewPolicyDraft, ReviewResponse } from '../types';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { cn } from '../lib/utils';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

type LoadState = 'loading' | 'loaded' | 'error';

interface EditablePolicy {
  goal: string;
  prohibitions: string[];
  constraints: string[];
}

const DERIVATION_STEPS = [
  'Looking through prompt history...',
  'Summarizing goals...',
  'Creating review policy...',
] as const;

function createEditablePolicy(policy: ReviewPolicyDraft | undefined): EditablePolicy {
  return {
    goal: policy?.goal ?? '',
    prohibitions: policy?.prohibitions ?? [],
    constraints: policy?.constraints ?? [],
  };
}

function normalizeEditablePolicy(policy: EditablePolicy): ReviewPolicyDraft {
  const normalizeList = (input: string[]): string[] =>
    Array.from(
      new Set(
        input
          .map((item) => item.trim())
          .filter(Boolean)
      )
    );

  const goal = policy.goal.trim();
  return {
    goal: goal ? goal : null,
    prohibitions: normalizeList(policy.prohibitions),
    constraints: normalizeList(policy.constraints),
  };
}

function StatusLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-5 py-12">
      <div className="w-full">{children}</div>
    </main>
  );
}

function PolicyListEditor(props: {
  clause: string;
  title: string;
  description: string;
  values: string[];
  placeholder: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, value: string) => void;
  addLabel: string;
  accentClass: string;
  animDelay: string;
}): JSX.Element {
  const { clause, title, description, values, placeholder, onAdd, onRemove, onChange, addLabel, accentClass, animDelay } = props;

  return (
    <Card
      className={cn(
        'policy-fade-up border-border/50 bg-card/80 backdrop-blur-sm',
        accentClass
      )}
      style={{ animationDelay: animDelay }}
    >
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center gap-2">
          <span className="policy-clause-number">{clause}</span>
          <CardTitle className="policy-section-title text-sm">{title}</CardTitle>
        </div>
        <CardDescription className="text-xs font-light">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        {values.length === 0 ? (
          <p className="text-sm text-muted-foreground/70 italic font-light">No entries yet.</p>
        ) : null}
        {values.map((value, index) => (
          <div key={`${title}-${index}`} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={value}
              onChange={(event) => onChange(index, event.target.value)}
              placeholder={placeholder}
              className="h-10 bg-background/60 border-border/50 font-light text-sm placeholder:text-muted-foreground/50 focus-visible:ring-[hsl(38_65%_38%)] focus-visible:ring-1 focus-visible:ring-offset-0"
            />
            <Button
              type="button"
              variant="ghost"
              className="h-10 shrink-0 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/5 text-xs font-medium tracking-wide uppercase"
              onClick={() => onRemove(index)}
            >
              Remove
            </Button>
          </div>
        ))}
      </CardContent>
      <CardFooter className="pt-0 px-4 pb-3">
        <Button
          type="button"
          variant="ghost"
          className="text-xs font-medium tracking-wide uppercase text-muted-foreground/70 hover:text-foreground hover:bg-accent/50 h-8 px-2"
          onClick={onAdd}
        >
          + {addLabel}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function PolicyPage(): JSX.Element {
  const { reviewId } = useParams<{ reviewId: string }>();
  const navigate = useNavigate();

  const [state, setState] = useState<LoadState>('loading');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [progressCycle, setProgressCycle] = useState(0);
  const [approving, setApproving] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<EditablePolicy>({ goal: '', prohibitions: [], constraints: [] });

  useEffect(() => {
    if (!reviewId) {
      setState('error');
      setErrorMessage('Missing review id in URL.');
      return;
    }

    let cancelled = false;
    const firstLoad = state !== 'loaded';
    if (firstLoad) {
      setState('loading');
    }

    fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${response.status})`);
        }

        const data = parseGetReviewResponse((await response.json()) as GetReviewResponse);
        if (cancelled) {
          return;
        }

        setReview(data.review);
        setState('loaded');
        setErrorMessage('');

        if (data.review.status === 'policy_ready') {
          setPolicyDraft((current) => {
            const currentNormalized = normalizeEditablePolicy(current);
            const hasDraft =
              Boolean(currentNormalized.goal) ||
              currentNormalized.prohibitions.length > 0 ||
              currentNormalized.constraints.length > 0;
            return hasDraft ? current : createEditablePolicy(data.review.derivedPolicy);
          });
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
    if (!review) {
      return;
    }

    if (
      review.status === 'policy_approved' ||
      review.status === 'queued' ||
      review.status === 'running' ||
      review.status === 'succeeded' ||
      review.status === 'failed' ||
      review.status === 'cancelled'
    ) {
      navigate(`/reports/${review.id}`);
    }
  }, [navigate, review]);

  useEffect(() => {
    if (!review || review.status !== 'policy_pending') {
      return;
    }

    const timer = window.setTimeout(() => {
      setRefreshCycle((value) => value + 1);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [review]);

  useEffect(() => {
    if (!review || review.status !== 'policy_pending') {
      return;
    }

    const timer = window.setTimeout(() => {
      setProgressCycle((value) => value + 1);
    }, 800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [review, progressCycle]);

  const progressLabel = useMemo(() => DERIVATION_STEPS[progressCycle % DERIVATION_STEPS.length], [progressCycle]);

  const approvePolicy = async () => {
    if (!reviewId || approving) {
      return;
    }

    setApproving(true);
    try {
      const approvedPolicy = normalizeEditablePolicy(policyDraft);
      const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/policy/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ approvedPolicy }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }

      navigate(`/reports/${reviewId}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setState('error');
    } finally {
      setApproving(false);
    }
  };

  if (state === 'loading') {
    return (
      <StatusLayout>
        <div className="policy-fade-up text-center space-y-4">
          <p className="policy-clause-number">preparing</p>
          <h1 className="policy-heading text-2xl text-foreground">Loading policy</h1>
          <p className="text-sm text-muted-foreground font-light">
            Review {reviewId ?? 'unknown'}
          </p>
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
        <Card className="policy-fade-up border-destructive/20 bg-card/90">
          <CardHeader className="text-center space-y-3">
            <p className="policy-clause-number text-destructive/70">error</p>
            <CardTitle className="policy-heading text-xl">Unable to prepare policy</CardTitle>
            <CardDescription className="font-light">
              {errorMessage || 'Unknown error'}
            </CardDescription>
          </CardHeader>
        </Card>
      </StatusLayout>
    );
  }

  if (!review) {
    return (
      <StatusLayout>
        <Card className="policy-fade-up border-border/50 bg-card/90">
          <CardHeader className="text-center space-y-3">
            <p className="policy-clause-number">empty</p>
            <CardTitle className="policy-heading text-xl">No review data</CardTitle>
            <CardDescription className="font-light">
              The review payload is empty.
            </CardDescription>
          </CardHeader>
        </Card>
      </StatusLayout>
    );
  }

  if (review.status !== 'policy_ready') {
    return (
      <StatusLayout>
        <div className="policy-fade-up text-center space-y-6">
          <div className="inline-flex items-center gap-2.5 rounded-full border border-border/50 bg-card/80 px-4 py-1.5 backdrop-blur-sm">
            <div className="h-2 w-2 rounded-full bg-[hsl(38_65%_45%)] animate-pulse" />
            <span className="text-xs font-medium tracking-widest uppercase text-muted-foreground">
              Deriving policy
            </span>
          </div>

          <div className="space-y-2">
            <h1 className="policy-heading text-3xl md:text-4xl text-foreground leading-tight">
              Policy draft in progress
            </h1>
            <p className="text-muted-foreground font-light text-base max-w-md mx-auto">
              {progressLabel}
            </p>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2">
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
            <span className="policy-derivation-dot" />
          </div>
        </div>
      </StatusLayout>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-4 md:py-6">
      <div className="policy-fade-up flex flex-col gap-1" style={{ animationDelay: '0ms' }}>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="policy-heading text-xl text-foreground tracking-tight">
            Review policy
          </h1>
          <p className="text-xs text-muted-foreground/60 font-light shrink-0">
            Policy will be locked after approval
          </p>
        </div>
        <p className="text-muted-foreground font-light text-sm">
          Confirm or edit this policy before Nimbus starts the review.
        </p>
      </div>

      <div className="h-px bg-border/60" />

      <div
        className="policy-fade-up flex flex-col gap-1.5"
        style={{ animationDelay: '60ms' }}
      >
        <div className="flex items-center gap-2">
          <span className="policy-clause-number">I.</span>
          <label className="policy-section-title text-sm">Goal</label>
          <span className="text-xs text-muted-foreground font-light">- What should this review optimize for?</span>
        </div>
        <Input
          value={policyDraft.goal}
          onChange={(event) => setPolicyDraft((current) => ({ ...current, goal: event.target.value }))}
          placeholder="Reduce production risk while keeping fixes minimal"
          className="h-9 bg-background/60 border-border/50 font-light text-sm placeholder:text-muted-foreground/50 focus-visible:ring-[hsl(38_65%_38%)] focus-visible:ring-1 focus-visible:ring-offset-0"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <PolicyListEditor
          clause="II."
          title="Must Not"
          description="Hard constraints Nimbus should avoid violating."
          values={policyDraft.prohibitions}
          placeholder="Do not alter public API behavior"
          addLabel="Add prohibition"
          accentClass="policy-card-prohibition"
          animDelay="120ms"
          onChange={(index, value) =>
            setPolicyDraft((current) => ({
              ...current,
              prohibitions: current.prohibitions.map((item, itemIndex) => (itemIndex === index ? value : item)),
            }))
          }
          onAdd={() =>
            setPolicyDraft((current) => ({
              ...current,
              prohibitions: [...current.prohibitions, ''],
            }))
          }
          onRemove={(index) =>
            setPolicyDraft((current) => ({
              ...current,
              prohibitions: current.prohibitions.filter((_, itemIndex) => itemIndex !== index),
            }))
          }
        />

        <PolicyListEditor
          clause="III."
          title="Preferences"
          description="Soft constraints Nimbus should prefer when possible."
          values={policyDraft.constraints}
          placeholder="Prefer small, isolated code changes"
          addLabel="Add preference"
          accentClass="policy-card-preference"
          animDelay="180ms"
          onChange={(index, value) =>
            setPolicyDraft((current) => ({
              ...current,
              constraints: current.constraints.map((item, itemIndex) => (itemIndex === index ? value : item)),
            }))
          }
          onAdd={() =>
            setPolicyDraft((current) => ({
              ...current,
              constraints: [...current.constraints, ''],
            }))
          }
          onRemove={(index) =>
            setPolicyDraft((current) => ({
              ...current,
              constraints: current.constraints.filter((_, itemIndex) => itemIndex !== index),
            }))
          }
        />
      </div>

      <div
        className="policy-fade-up flex justify-end pt-1"
        style={{ animationDelay: '240ms' }}
      >
        <button
          type="button"
          className="policy-approve-btn inline-flex items-center justify-center rounded-lg h-10 px-6 text-sm"
          onClick={approvePolicy}
          disabled={approving}
        >
          {approving ? 'Confirming...' : 'Approve & run review'}
        </button>
      </div>
    </main>
  );
}
