import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudioDataSource } from '../../data/studio/StudioDataSource';
import type {
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentMergeBackResponse,
  StudioAdoptResponse,
  StudioSessionActivityEntry,
  StudioSessionActivitySnapshot,
  StudioSessionAggregateResponse,
} from '../../types';
import { createEditablePolicyDraft, normalizeEditablePolicyDraft, type EditablePolicyDraft } from './sessionPolicy';
import { buildSessionViewModel, type SessionViewModel } from './sessionViewModel';

export interface StudioSessionControllerResult {
  status: 'loading' | 'unavailable' | 'ready';
  error: string | null;
  viewModel: SessionViewModel | null;
  policyDraft: EditablePolicyDraft;
  setPolicyField(field: keyof EditablePolicyDraft, value: string): void;
  policyMessage: string | null;
  policyError: string | null;
  submittingPolicy: boolean;
  adoptError: string | null;
  adopting: boolean;
  localDiffError: string | null;
  localDiffLoading: boolean;
  mergeBackResult: LocalReviewEnvironmentMergeBackResponse | null;
  mergeBackError: string | null;
  mergingBack: boolean;
  handleApprovePolicy(): Promise<void>;
  handleAdopt(): Promise<void>;
  handleMergeBack(): Promise<void>;
}

export function useStudioSessionController(sessionId: string | undefined): StudioSessionControllerResult {
  const dataSource = useStudioDataSource();
  const streamRef = useRef<{ close(): void } | null>(null);
  const [aggregate, setAggregate] = useState<StudioSessionAggregateResponse | null>(null);
  const [activity, setActivity] = useState<StudioSessionActivitySnapshot | null>(null);
  const [events, setEvents] = useState<StudioSessionActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<EditablePolicyDraft>(createEditablePolicyDraft(undefined));
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [submittingPolicy, setSubmittingPolicy] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptResult, setAdoptResult] = useState<StudioAdoptResponse | null>(null);
  const [localDiff, setLocalDiff] = useState<LocalReviewEnvironmentDiffResponse | null>(null);
  const [localDiffError, setLocalDiffError] = useState<string | null>(null);
  const [localDiffLoading, setLocalDiffLoading] = useState(false);
  const [mergeBackResult, setMergeBackResult] = useState<LocalReviewEnvironmentMergeBackResponse | null>(null);
  const [mergeBackError, setMergeBackError] = useState<string | null>(null);
  const [mergingBack, setMergingBack] = useState(false);

  const loadAggregate = useCallback(
    async (options?: { background?: boolean }) => {
      if (!sessionId) {
        setError('Session ID is missing from the route.');
        setLoading(false);
        return;
      }
      if (!options?.background) {
        setLoading(true);
      }
      setError(null);
      try {
        const nextAggregate = await dataSource.loadSession(sessionId);
        setAggregate(nextAggregate);
        setActivity(nextAggregate.activity);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [dataSource, sessionId]
  );

  useEffect(() => {
    setEvents([]);
    setAggregate(null);
    setActivity(null);
    setAdoptResult(null);
    setMergeBackResult(null);
    setLocalDiff(null);
    void loadAggregate();
    return () => {
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [loadAggregate]);

  useEffect(() => {
    if (!aggregate?.activeReview?.derivedPolicy) {
      return;
    }
    setPolicyDraft(createEditablePolicyDraft(aggregate.activeReview.derivedPolicy));
  }, [aggregate?.activeReview?.derivedPolicy, aggregate?.activeReview?.id]);

  const primaryEnvironment = aggregate?.local.environments[0] ?? null;

  const loadLocalDiff = useCallback(
    async (path: string) => {
      setLocalDiffLoading(true);
      setLocalDiffError(null);
      try {
        const nextDiff = await dataSource.loadLocalDiff(path);
        setLocalDiff(nextDiff);
      } catch (diffError) {
        setLocalDiffError(diffError instanceof Error ? diffError.message : String(diffError));
      } finally {
        setLocalDiffLoading(false);
      }
    },
    [dataSource]
  );

  useEffect(() => {
    if (!primaryEnvironment?.diffPath) {
      setLocalDiff(null);
      return;
    }
    void loadLocalDiff(primaryEnvironment.diffPath);
  }, [loadLocalDiff, primaryEnvironment?.diffPath]);

  useEffect(() => {
    if (!aggregate) {
      streamRef.current?.close();
      streamRef.current = null;
      return;
    }

    streamRef.current?.close();
    streamRef.current = dataSource.subscribeToSessionActivity(aggregate, {
      onEvent(event) {
        if (event.type === 'activity') {
          setEvents((current) => [...current, event].slice(-200));
          return;
        }
        if (event.type === 'snapshot' || event.type === 'terminal') {
          setActivity(event.activity);
          void loadAggregate({ background: true });
          return;
        }
        setError(event.message);
      },
      onError(streamError) {
        setError(streamError.message);
      },
    });

    return () => {
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [aggregate, dataSource, loadAggregate]);

  const currentActivity = activity ?? aggregate?.activity ?? null;

  const viewModel = useMemo(() => {
    if (!aggregate || !currentActivity) {
      return null;
    }
    return buildSessionViewModel({
      aggregate,
      activity: currentActivity,
      events,
      localDiff,
      adoptResult,
    });
  }, [activity, adoptResult, aggregate, currentActivity, events, localDiff]);

  const handleApprovePolicy = useCallback(async () => {
    if (!viewModel?.policy.reviewId) {
      return;
    }
    setSubmittingPolicy(true);
    setPolicyMessage(null);
    setPolicyError(null);
    try {
      await dataSource.approvePolicy({
        reviewId: viewModel.policy.reviewId,
        approvedPolicy: normalizeEditablePolicyDraft(policyDraft),
      });
      setPolicyMessage('Policy approved. Nimbus will continue the session.');
      await loadAggregate({ background: true });
    } catch (approveError) {
      setPolicyError(approveError instanceof Error ? approveError.message : String(approveError));
    } finally {
      setSubmittingPolicy(false);
    }
  }, [dataSource, loadAggregate, policyDraft, viewModel?.policy.reviewId]);

  const handleAdopt = useCallback(async () => {
    if (!aggregate?.adopt.available) {
      return;
    }
    setAdopting(true);
    setAdoptError(null);
    setMergeBackResult(null);
    try {
      const result = await dataSource.adoptSession({
        path: aggregate.adopt.path,
        mode: 'worktree',
      });
      setAdoptResult(result);
      await loadAggregate({ background: true });
    } catch (adoptFailure) {
      setAdoptError(adoptFailure instanceof Error ? adoptFailure.message : String(adoptFailure));
    } finally {
      setAdopting(false);
    }
  }, [aggregate?.adopt.available, aggregate?.adopt.path, dataSource, loadAggregate]);

  const handleMergeBack = useCallback(async () => {
    if (!primaryEnvironment?.mergeBackPath) {
      return;
    }
    setMergingBack(true);
    setMergeBackError(null);
    try {
      const result = await dataSource.mergeBack(primaryEnvironment.mergeBackPath);
      setMergeBackResult(result);
      if (primaryEnvironment.diffPath) {
        await loadLocalDiff(primaryEnvironment.diffPath);
      }
    } catch (mergeError) {
      setMergeBackError(mergeError instanceof Error ? mergeError.message : String(mergeError));
    } finally {
      setMergingBack(false);
    }
  }, [dataSource, loadLocalDiff, primaryEnvironment?.diffPath, primaryEnvironment?.mergeBackPath]);

  if (loading && !aggregate) {
    return {
      status: 'loading',
      error,
      viewModel: null,
      policyDraft,
      setPolicyField: (field, value) => setPolicyDraft((current) => ({ ...current, [field]: value })),
      policyMessage,
      policyError,
      submittingPolicy,
      adoptError,
      adopting,
      localDiffError,
      localDiffLoading,
      mergeBackResult,
      mergeBackError,
      mergingBack,
      handleApprovePolicy,
      handleAdopt,
      handleMergeBack,
    };
  }

  if (!aggregate || !currentActivity || !viewModel) {
    return {
      status: 'unavailable',
      error: error ?? 'Nimbus could not load the requested session.',
      viewModel: null,
      policyDraft,
      setPolicyField: (field, value) => setPolicyDraft((current) => ({ ...current, [field]: value })),
      policyMessage,
      policyError,
      submittingPolicy,
      adoptError,
      adopting,
      localDiffError,
      localDiffLoading,
      mergeBackResult,
      mergeBackError,
      mergingBack,
      handleApprovePolicy,
      handleAdopt,
      handleMergeBack,
    };
  }

  return {
    status: 'ready',
    error,
    viewModel,
    policyDraft,
    setPolicyField: (field, value) => setPolicyDraft((current) => ({ ...current, [field]: value })),
    policyMessage,
    policyError,
    submittingPolicy,
    adoptError,
    adopting,
    localDiffError,
    localDiffLoading,
    mergeBackResult,
    mergeBackError,
    mergingBack,
    handleApprovePolicy,
    handleAdopt,
    handleMergeBack,
  };
}
