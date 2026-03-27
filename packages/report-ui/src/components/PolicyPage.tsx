import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseGetReviewResponse } from '../lib/review';
import type { GetReviewResponse, ReviewPolicyDraft, ReviewResponse } from '../types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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

function StatusLayout({ children, cardClassName }: { children: React.ReactNode; cardClassName?: string }): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-8 md:px-6">
      <Card className={cn('w-full', cardClassName)}>{children}</Card>
    </main>
  );
}

function PolicyListEditor(props: {
  title: string;
  description: string;
  values: string[];
  placeholder: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, value: string) => void;
  addLabel: string;
}): JSX.Element {
  const { title, description, values, placeholder, onAdd, onRemove, onChange, addLabel } = props;

  return (
    <Card className="border-slate-200/80 bg-white/90 backdrop-blur">
      <CardHeader>
        <CardTitle className="text-base md:text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {values.length === 0 ? <p className="text-sm text-muted-foreground">No entries yet.</p> : null}
        {values.map((value, index) => (
          <div key={`${title}-${index}`} className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={value}
              onChange={(event) => onChange(index, event.target.value)}
              placeholder={placeholder}
              className="h-11"
            />
            <Button type="button" variant="outline" className="h-11 shrink-0" onClick={() => onRemove(index)}>
              Remove
            </Button>
          </div>
        ))}
      </CardContent>
      <CardFooter>
        <Button type="button" variant="secondary" onClick={onAdd}>
          {addLabel}
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

  const progressLabel = useMemo(() => {
    return DERIVATION_STEPS[progressCycle % DERIVATION_STEPS.length];
  }, [progressCycle]);

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
      <StatusLayout cardClassName="border-slate-200/80 bg-white/90">
        <CardHeader>
          <CardTitle>Preparing policy</CardTitle>
          <CardDescription>Loading review {reviewId ?? 'unknown'}...</CardDescription>
        </CardHeader>
      </StatusLayout>
    );
  }

  if (state === 'error') {
    return (
      <StatusLayout cardClassName="border-red-200 bg-white/95">
        <CardHeader>
          <CardTitle>Unable to prepare policy</CardTitle>
          <CardDescription>{errorMessage || 'Unknown error'}</CardDescription>
        </CardHeader>
      </StatusLayout>
    );
  }

  if (!review) {
    return (
      <StatusLayout cardClassName="border-slate-200/80 bg-white/90">
        <CardHeader>
          <CardTitle>No review data</CardTitle>
          <CardDescription>The review payload is empty.</CardDescription>
        </CardHeader>
      </StatusLayout>
    );
  }

  if (review.status !== 'policy_ready') {
    return (
      <StatusLayout cardClassName="border-sky-200 bg-white/95">
        <CardHeader className="space-y-3">
          <Badge variant="secondary" className="w-fit bg-sky-100 text-sky-900">
            Deriving policy
          </Badge>
          <CardTitle>Policy draft in progress</CardTitle>
          <CardDescription>{progressLabel}</CardDescription>
        </CardHeader>
      </StatusLayout>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-6 md:py-10">
      <Card className="border-slate-200/80 bg-white/90 backdrop-blur">
        <CardHeader className="space-y-3">
          <Badge variant="secondary" className="w-fit bg-sky-100 text-sky-900">
            {review.status.replace('_', ' ')}
          </Badge>
          <CardTitle className="text-2xl tracking-tight">Review policy draft</CardTitle>
          <CardDescription>
            Confirm or edit this policy before Nimbus starts the review. Edits are normalized and deduplicated automatically when you submit.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="border-slate-200/80 bg-white/90 backdrop-blur">
        <CardHeader>
          <CardTitle className="text-base md:text-lg">Goal</CardTitle>
          <CardDescription>What should this review optimize for?</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            value={policyDraft.goal}
            onChange={(event) => setPolicyDraft((current) => ({ ...current, goal: event.target.value }))}
            placeholder="Reduce production risk while keeping fixes minimal"
            className="h-11"
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <PolicyListEditor
          title="Must Not"
          description="Hard constraints Nimbus should avoid violating."
          values={policyDraft.prohibitions}
          placeholder="Do not alter public API behavior"
          addLabel="Add must-not item"
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
          title="Preferences"
          description="Soft constraints Nimbus should prefer when possible."
          values={policyDraft.constraints}
          placeholder="Prefer small, isolated code changes"
          addLabel="Add preference item"
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

      <Card className="border-slate-200/80 bg-white/90">
        <CardFooter className="justify-end">
          <Button type="button" size="lg" onClick={approvePolicy} disabled={approving}>
            {approving ? 'Confirming...' : 'Confirm policy and run review'}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
