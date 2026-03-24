import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parseGetReviewResponse } from '../lib/review';
import type { GetReviewResponse, ReviewPolicyDraft, ReviewResponse } from '../types';

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

function listEditor(
  label: string,
  values: string[],
  onChange: (index: number, value: string) => void,
  onAdd: () => void,
  onRemove: (index: number) => void,
  placeholder: string,
  addLabel: string
): JSX.Element {
  return (
    <section className="card">
      <h3>{label}</h3>
      <div className="stack">
        {values.length === 0 && <p>No entries yet.</p>}
        {values.map((value, index) => (
          <div key={`${label}-${index}`} className="button-row">
            <input
              value={value}
              onChange={(event) => onChange(index, event.target.value)}
              placeholder={placeholder}
            />
            <button type="button" className="secondary-button" onClick={() => onRemove(index)}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="secondary-button" onClick={onAdd}>
        {addLabel}
      </button>
    </section>
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

  console.log('[PolicyPage] render', {
    reviewId: reviewId ?? null,
    state,
    reviewStatus: review?.status ?? null,
  });

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
        console.log('[PolicyPage] fetched review status', {
          reviewId,
          status: data.review.status,
        });
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
          console.error('[PolicyPage] fetch failed', {
            reviewId,
            error: error instanceof Error ? error.message : String(error),
          });
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
      <main className="page">
        <section className="card status-card">
          <h1>Preparing policy</h1>
          <p>Loading review {reviewId ?? 'unknown'}...</p>
        </section>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>Unable to prepare policy</h1>
          <p>{errorMessage || 'Unknown error'}</p>
        </section>
      </main>
    );
  }

  if (!review) {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>No review data</h1>
          <p>The review payload is empty.</p>
        </section>
      </main>
    );
  }

  if (review.status !== 'policy_ready') {
    return (
      <main className="page">
        <section className="card status-card">
          <h1>Deriving policy</h1>
          <p>{progressLabel}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="card summary-card">
        <div className="summary-header">
          <h1>Review policy draft</h1>
          <span className="status-pill status-running">{review.status}</span>
        </div>
        <p>Confirm or edit the policy before Nimbus starts the review.</p>
      </section>

      <section className="card">
        <h3>Goal</h3>
        <input
          value={policyDraft.goal}
          onChange={(event) => setPolicyDraft((current) => ({ ...current, goal: event.target.value }))}
          placeholder="What should this review optimize for?"
        />
      </section>

      {listEditor(
        'Must Not',
        policyDraft.prohibitions,
        (index, value) =>
          setPolicyDraft((current) => ({
            ...current,
            prohibitions: current.prohibitions.map((item, itemIndex) => (itemIndex === index ? value : item)),
          })),
        () =>
          setPolicyDraft((current) => ({
            ...current,
            prohibitions: [...current.prohibitions, ''],
          })),
        (index) =>
          setPolicyDraft((current) => ({
            ...current,
            prohibitions: current.prohibitions.filter((_, itemIndex) => itemIndex !== index),
          })),
        'Add a prohibition',
        'Add must-not item'
      )}

      {listEditor(
        'Preferences',
        policyDraft.constraints,
        (index, value) =>
          setPolicyDraft((current) => ({
            ...current,
            constraints: current.constraints.map((item, itemIndex) => (itemIndex === index ? value : item)),
          })),
        () =>
          setPolicyDraft((current) => ({
            ...current,
            constraints: [...current.constraints, ''],
          })),
        (index) =>
          setPolicyDraft((current) => ({
            ...current,
            constraints: current.constraints.filter((_, itemIndex) => itemIndex !== index),
          })),
        'Add a preference',
        'Add preference item'
      )}

      <section className="card status-card">
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={approvePolicy} disabled={approving}>
            {approving ? 'Confirming...' : 'Confirm policy and run review'}
          </button>
        </div>
      </section>
    </main>
  );
}
