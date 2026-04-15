import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  dateTimeLabel,
  parseLocalReviewEnvironmentDiffResponse,
  parseLocalReviewEnvironmentMergeBackResponse,
  parseStudioSessionActivityEvent,
  parseStudioSessionAggregateResponse,
} from '../lib/review';
import type {
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentMergeBackResponse,
  ReviewContextMode,
  ReviewFinding,
  ReviewPolicyDraft,
  ReviewResponse,
  ReviewSessionResponse,
  StudioSessionActivityEntry,
  StudioSessionActivitySnapshot,
  StudioSessionAggregateResponse,
} from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const ENTIRE_DOCS_URL = 'https://github.com/dayhaysoos/nimbus/blob/main/docs/entire/recovery.md';
const REVIEWED_DIFF_MAX_BYTES = 200_000;

interface EditablePolicyDraft {
  goal: string;
  prohibitions: string;
  constraints: string;
}

interface AdoptResponse {
  sessionId: string;
  mode: 'worktree' | 'branch';
  branchName: string;
  worktreePath: string | null;
  artifactId: string;
  artifactSha256: string;
  latestReviewId: string;
  anchorCommitSha: string;
  commitSha: string | null;
  enterCommand: string;
}

interface StreamedFinding {
  id: string;
  passIndex: number;
  reviewId: string;
  severity: string;
  title: string;
  description: string;
  location: string | null;
}

function buildSessionPath(session: Pick<ReviewSessionResponse, 'id' | 'repo' | 'branch'>): string {
  return `/branches/${encodeURIComponent(session.repo)}/${encodeURIComponent(session.branch)}/sessions/${encodeURIComponent(
    session.id
  )}`;
}

function createEditablePolicyDraft(policy: ReviewPolicyDraft | undefined): EditablePolicyDraft {
  return {
    goal: policy?.goal ?? '',
    prohibitions: (policy?.prohibitions ?? []).join('\n'),
    constraints: (policy?.constraints ?? []).join('\n'),
  };
}

function normalizeEditablePolicyDraft(policy: EditablePolicyDraft): ReviewPolicyDraft {
  const normalizeLines = (input: string): string[] =>
    Array.from(
      new Set(
        input
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      )
    );

  const goal = policy.goal.trim();
  return {
    goal: goal ? goal : null,
    prohibitions: normalizeLines(policy.prohibitions),
    constraints: normalizeLines(policy.constraints),
  };
}

function readErrorMessage(payload: unknown): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (error && typeof error === 'object' && !Array.isArray(error) && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
  }
  return 'Request failed.';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchAggregate(sessionId: string): Promise<StudioSessionAggregateResponse> {
  const response = await fetch(
    `${API_BASE}/api/studio/sessions/${encodeURIComponent(sessionId)}?includeReviewedDiff=1&includePatch=1&maxBytes=${REVIEWED_DIFF_MAX_BYTES}`
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(payload));
  }
  return parseStudioSessionAggregateResponse(payload);
}

function resolveContextMode(aggregate: StudioSessionAggregateResponse | null): ReviewContextMode | null {
  if (!aggregate) {
    return null;
  }
  return (
    aggregate.session.outcome?.reviewed.contextMode ??
    aggregate.latestReview?.provenance.reviewContextMode ??
    aggregate.activeReview?.provenance.reviewContextMode ??
    null
  );
}

function isTerminalPhase(phase: ReviewSessionResponse['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function modeLabel(mode: ReviewContextMode | null): string {
  if (mode === 'intent_aware') {
    return 'Intent-aware';
  }
  if (mode === 'basic') {
    return 'Basic';
  }
  return 'Pending';
}

function severityClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') {
    return 'severity-pill danger';
  }
  if (severity === 'medium') {
    return 'severity-pill warning';
  }
  if (severity === 'low' || severity === 'info') {
    return 'severity-pill neutral';
  }
  return 'severity-pill neutral';
}

function findingHeading(finding: ReviewFinding): string {
  return finding.title?.trim() || finding.description;
}

function shouldShowFindingDescription(finding: ReviewFinding): boolean {
  const heading = findingHeading(finding).trim();
  const description = finding.description.trim();
  return Boolean(description) && description !== heading;
}

function findingLocation(finding: ReviewFinding): string | null {
  const first = finding.locations[0];
  if (!first) {
    return null;
  }
  if (first.startLine !== null) {
    return `${first.filePath}:${first.startLine}`;
  }
  return first.filePath;
}

function formatPassStatus(review: ReviewResponse | null, pass: ReviewSessionResponse['passes'][number]): string {
  const value = review?.status ?? pass.status;
  return value.replace(/_/g, ' ');
}

function buildPassSummary(review: ReviewResponse | null, pass: ReviewSessionResponse['passes'][number]): string {
  if (review?.summaryText?.trim()) {
    return review.summaryText.trim();
  }
  if (pass.status === 'succeeded') {
    return review?.findings.length ? `${review.findings.length} finding(s) captured during this pass.` : 'Nimbus completed this pass without findings.';
  }
  if (pass.status === 'running' || pass.status === 'queued') {
    return 'Nimbus is still working through this pass.';
  }
  if (pass.status === 'failed') {
    return review?.error?.message ?? 'This pass ended in a failure.';
  }
  return 'Pass metadata is available, but Nimbus has not published a summary yet.';
}

function buildStreamedFinding(event: StudioSessionActivityEntry, index: number): StreamedFinding | null {
  if (event.kind !== 'finding') {
    return null;
  }
  const payload = event.payload;
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : typeof payload.description === 'string' && payload.description.trim()
        ? payload.description.trim()
        : event.detail;
  const locations = Array.isArray(payload.locations) ? payload.locations : [];
  const firstLocation = locations[0];
  let location: string | null = null;
  if (firstLocation && typeof firstLocation === 'object' && !Array.isArray(firstLocation)) {
    const record = firstLocation as { path?: unknown; line?: unknown };
    if (typeof record.path === 'string' && record.path.trim()) {
      location =
        typeof record.line === 'number' && Number.isFinite(record.line) ? `${record.path}:${record.line}` : record.path;
    }
  }

  return {
    id: `${event.reviewId}-${event.seq ?? index}-${index}`,
    passIndex: event.passIndex,
    reviewId: event.reviewId,
    severity: typeof payload.severity === 'string' ? payload.severity : 'info',
    title,
    description: typeof payload.description === 'string' && payload.description.trim() ? payload.description : event.detail,
    location,
  };
}

function groupEventsByReview(events: StudioSessionActivityEntry[]): Map<string, StudioSessionActivityEntry[]> {
  const grouped = new Map<string, StudioSessionActivityEntry[]>();
  for (const event of events) {
    const existing = grouped.get(event.reviewId) ?? [];
    grouped.set(event.reviewId, [...existing, event]);
  }
  return grouped;
}

function FindingList(props: {
  title: string;
  findings: ReviewFinding[];
  empty: string;
}): JSX.Element {
  return (
    <section className="flow-section">
      <div className="section-header">
        <div>
          <p className="eyebrow">Findings</p>
          <h2>{props.title}</h2>
        </div>
      </div>
      {props.findings.length === 0 ? (
        <div className="empty-card">{props.empty}</div>
      ) : (
        <div className="finding-list">
          {props.findings.map((finding, index) => (
            <motion.article
              key={`${findingHeading(finding)}-${findingLocation(finding) ?? index}`}
              className="finding-card"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.03, 0.18) }}
            >
              <div className="finding-header">
                <span className={severityClass(finding.severity)}>{finding.severity}</span>
                {findingLocation(finding) ? <span className="finding-location">{findingLocation(finding)}</span> : null}
              </div>
              <strong>{findingHeading(finding)}</strong>
              {shouldShowFindingDescription(finding) ? <p>{finding.description}</p> : null}
              {finding.suggestedFix.trim() ? (
                <div className="finding-note">
                  <span>Suggested fix</span>
                  <p>{finding.suggestedFix}</p>
                </div>
              ) : null}
            </motion.article>
          ))}
        </div>
      )}
    </section>
  );
}

export function ReviewSessionPage(): JSX.Element {
  const { sessionId } = useParams();
  const streamRef = useRef<EventSource | null>(null);
  const [aggregate, setAggregate] = useState<StudioSessionAggregateResponse | null>(null);
  const [activity, setActivity] = useState<StudioSessionActivitySnapshot | null>(null);
  const [events, setEvents] = useState<StudioSessionActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPassId, setExpandedPassId] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<EditablePolicyDraft>(createEditablePolicyDraft(undefined));
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [submittingPolicy, setSubmittingPolicy] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptResult, setAdoptResult] = useState<AdoptResponse | null>(null);
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
        const nextAggregate = await fetchAggregate(sessionId);
        setAggregate(nextAggregate);
        setActivity(nextAggregate.activity);
        setExpandedPassId((current) => current ?? nextAggregate.session.passes[nextAggregate.session.passes.length - 1]?.reviewId ?? null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
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
  }, [aggregate?.activeReview?.id, aggregate?.activeReview?.derivedPolicy]);

  const primaryEnvironment = aggregate?.local.environments[0] ?? null;

  const loadLocalDiff = useCallback(async (path: string) => {
    setLocalDiffLoading(true);
    setLocalDiffError(null);
    try {
      const response = await fetch(`${API_BASE}${path}`);
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }
      setLocalDiff(parseLocalReviewEnvironmentDiffResponse(payload));
    } catch (diffError) {
      setLocalDiffError(diffError instanceof Error ? diffError.message : String(diffError));
    } finally {
      setLocalDiffLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!primaryEnvironment?.diffPath) {
      setLocalDiff(null);
      return;
    }
    void loadLocalDiff(primaryEnvironment.diffPath);
  }, [loadLocalDiff, primaryEnvironment?.diffPath]);

  useEffect(() => {
    if (!aggregate?.activity.canStream || isTerminalPhase(aggregate.session.phase)) {
      streamRef.current?.close();
      streamRef.current = null;
      return;
    }

    streamRef.current?.close();
    const source = new EventSource(`${API_BASE}${aggregate.paths.activityEvents}`);
    streamRef.current = source;

    const handleMessage = (messageEvent: MessageEvent<string>): void => {
      try {
        const event = parseStudioSessionActivityEvent(JSON.parse(messageEvent.data) as unknown);
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
      } catch (streamError) {
        setError(streamError instanceof Error ? streamError.message : String(streamError));
      }
    };

    const handleTransportError = (): void => {
      source.close();
      if (!isTerminalPhase(aggregate.session.phase)) {
        setError('The live session stream disconnected. Refresh the page to reconnect.');
      }
    };

    source.addEventListener('message', handleMessage);
    source.addEventListener('error', handleTransportError);

    return () => {
      source.close();
      if (streamRef.current === source) {
        streamRef.current = null;
      }
    };
  }, [aggregate?.activity.canStream, aggregate?.paths.activityEvents, aggregate?.session.phase, loadAggregate]);

  const currentActivity = activity ?? aggregate?.activity ?? null;
  const reviewsById = useMemo(() => new Map((aggregate?.reviews ?? []).map((review) => [review.id, review])), [aggregate?.reviews]);
  const eventsByReview = useMemo(() => groupEventsByReview(events), [events]);
  const streamedFindings = useMemo(
    () =>
      events
        .map((event, index) => buildStreamedFinding(event, index))
        .filter((finding): finding is StreamedFinding => Boolean(finding)),
    [events]
  );
  const contextMode = resolveContextMode(aggregate);
  const latestReview = aggregate?.latestReview ?? null;
  const activeReview = aggregate?.activeReview ?? null;
  const isWaitingOnHuman = aggregate?.capabilities.waitingOnHuman === true;
  const isTerminal = aggregate?.capabilities.terminal === true;
  const canShowReviewedDiff = aggregate?.capabilities.canShowReviewedDiff === true && aggregate.reviewedDiff.available;
  const canAdopt = aggregate?.capabilities.canAdopt === true && aggregate.adopt.available;
  const unresolvedFindings = aggregate?.findings.unresolved ?? [];
  const resolvedFindings = useMemo(
    () => (aggregate?.findings.resolved ?? []).map((entry) => entry.finding),
    [aggregate?.findings.resolved]
  );

  const handleApprovePolicy = useCallback(async () => {
    if (!activeReview) {
      return;
    }
    setSubmittingPolicy(true);
    setPolicyMessage(null);
    setPolicyError(null);
    try {
      const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(activeReview.id)}/policy/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          approvedPolicy: normalizeEditablePolicyDraft(policyDraft),
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }
      setPolicyMessage('Policy approved. Nimbus will continue the session.');
      await loadAggregate({ background: true });
    } catch (approveError) {
      setPolicyError(approveError instanceof Error ? approveError.message : String(approveError));
    } finally {
      setSubmittingPolicy(false);
    }
  }, [activeReview, loadAggregate, policyDraft]);

  const handleAdopt = useCallback(async () => {
    if (!aggregate?.adopt.available) {
      return;
    }
    setAdopting(true);
    setAdoptError(null);
    setMergeBackResult(null);
    try {
      const response = await fetch(`${API_BASE}${aggregate.adopt.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'worktree' }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }
      setAdoptResult(payload as AdoptResponse);
      await loadAggregate({ background: true });
    } catch (adoptFailure) {
      setAdoptError(adoptFailure instanceof Error ? adoptFailure.message : String(adoptFailure));
    } finally {
      setAdopting(false);
    }
  }, [aggregate?.adopt.available, aggregate?.adopt.path, loadAggregate]);

  const handleMergeBack = useCallback(async () => {
    if (!primaryEnvironment?.mergeBackPath) {
      return;
    }
    setMergingBack(true);
    setMergeBackError(null);
    try {
      const response = await fetch(`${API_BASE}${primaryEnvironment.mergeBackPath}`, {
        method: 'POST',
      });
      const payload = await readJson(response);
      if (!response.ok) {
        throw new Error(readErrorMessage(payload));
      }
      setMergeBackResult(parseLocalReviewEnvironmentMergeBackResponse(payload));
      await loadLocalDiff(primaryEnvironment.diffPath);
    } catch (mergeError) {
      setMergeBackError(mergeError instanceof Error ? mergeError.message : String(mergeError));
    } finally {
      setMergingBack(false);
    }
  }, [loadLocalDiff, primaryEnvironment?.diffPath, primaryEnvironment?.mergeBackPath]);

  if (loading && !aggregate) {
    return (
      <main className="studio-shell">
        <section className="panel-card">
          <p className="eyebrow">Loading</p>
          <h1>Loading review session…</h1>
        </section>
      </main>
    );
  }

  if (!aggregate || !currentActivity) {
    return (
      <main className="studio-shell">
        <section className="panel-card">
          <p className="eyebrow">Session</p>
          <h1>Review session unavailable</h1>
          <p className="panel-body">{error ?? 'Nimbus could not load the requested session.'}</p>
          <Link className="inline-link" to="/">
            Back to launch
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="studio-shell">
      <motion.section
        className="hero-card"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <div className="hero-copy">
          <div className="hero-title-row">
            <div>
              <p className="eyebrow">Review session</p>
              <h1>{aggregate.session.id}</h1>
            </div>
            <span className={`status-pill ${isTerminal ? 'terminal' : isWaitingOnHuman ? 'waiting' : 'live'}`}>
              {aggregate.session.phase.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="hero-body">{currentActivity.detail}</p>
          <div className="hero-links">
            <Link className="inline-link" to="/">
              Back to launch
            </Link>
            <Link className="inline-link" to={buildSessionPath(aggregate.session)}>
              Refresh canonical route
            </Link>
          </div>
        </div>

        <div className="hero-meta">
          <div className="meta-chip">
            <span>Repository</span>
            <strong>{aggregate.session.repo}</strong>
          </div>
          <div className="meta-chip">
            <span>Branch</span>
            <strong>{aggregate.session.branch}</strong>
          </div>
          <div className="meta-chip">
            <span>Mode</span>
            <strong>{modeLabel(contextMode)}</strong>
          </div>
          <div className="meta-chip">
            <span>Passes</span>
            <strong>{aggregate.session.passCount}</strong>
          </div>
        </div>
      </motion.section>

      {contextMode === 'basic' ? (
        <motion.section
          className="notice-card warning"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.25 }}
        >
          <strong>Basic-mode session</strong>
          <p>Nimbus is reviewing the current commit without Entire-backed intent context.</p>
          <a className="inline-link" href={ENTIRE_DOCS_URL} target="_blank" rel="noreferrer">
            Learn more about Entire
          </a>
        </motion.section>
      ) : null}

      {error ? (
        <section className="notice-card error">
          <strong>Live session error</strong>
          <p>{error}</p>
        </section>
      ) : null}

      {isWaitingOnHuman && activeReview?.status === 'policy_ready' && activeReview.derivedPolicy ? (
        <motion.section
          className="panel-card"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.28 }}
        >
          <div className="section-header">
            <div>
              <p className="eyebrow">Human step</p>
              <h2>Approve the review policy</h2>
            </div>
          </div>
          <p className="panel-body">
            Nimbus paused before the pass could continue. Review the policy below, edit it if needed, then approve it to
            resume the session.
          </p>
          <div className="policy-grid">
            <label className="field-stack">
              <span>Goal</span>
              <textarea
                value={policyDraft.goal}
                onChange={(event) => setPolicyDraft((current) => ({ ...current, goal: event.target.value }))}
                rows={3}
              />
            </label>
            <label className="field-stack">
              <span>Prohibitions</span>
              <textarea
                value={policyDraft.prohibitions}
                onChange={(event) => setPolicyDraft((current) => ({ ...current, prohibitions: event.target.value }))}
                rows={5}
              />
            </label>
            <label className="field-stack">
              <span>Constraints</span>
              <textarea
                value={policyDraft.constraints}
                onChange={(event) => setPolicyDraft((current) => ({ ...current, constraints: event.target.value }))}
                rows={5}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={handleApprovePolicy} disabled={submittingPolicy}>
              {submittingPolicy ? 'Approving policy…' : 'Approve policy'}
            </button>
          </div>
          {policyMessage ? (
            <div className="notice-card success">
              <strong>Policy approved</strong>
              <p>{policyMessage}</p>
            </div>
          ) : null}
          {policyError ? (
            <div className="notice-card error">
              <strong>Approval failed</strong>
              <p>{policyError}</p>
            </div>
          ) : null}
        </motion.section>
      ) : null}

      {streamedFindings.length > 0 && !isTerminal ? (
        <section className="flow-section">
          <div className="section-header">
            <div>
              <p className="eyebrow">Live findings</p>
              <h2>Findings materializing during the current session</h2>
            </div>
          </div>
          <div className="finding-list">
            {streamedFindings.map((finding) => (
              <motion.article
                key={finding.id}
                className="finding-card"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="finding-header">
                  <span className={severityClass(finding.severity)}>{finding.severity}</span>
                  {finding.location ? <span className="finding-location">{finding.location}</span> : null}
                </div>
                <strong>{finding.title}</strong>
                <p>{finding.description}</p>
              </motion.article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flow-section">
        <div className="section-header">
          <div>
            <p className="eyebrow">Pass timeline</p>
            <h2>Review loop</h2>
          </div>
        </div>
        <div className="pass-stack">
          {aggregate.session.passes.map((pass, index) => {
            const review = reviewsById.get(pass.reviewId) ?? null;
            const passEvents = eventsByReview.get(pass.reviewId) ?? [];
            const isExpanded = expandedPassId === pass.reviewId;
            return (
              <motion.article
                key={pass.reviewId}
                className={`pass-card ${isExpanded ? 'expanded' : 'collapsed'}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.04, 0.18) }}
              >
                <button className="pass-toggle" onClick={() => setExpandedPassId(isExpanded ? null : pass.reviewId)}>
                  <div>
                    <p className="eyebrow">Pass {index + 1}</p>
                    <strong>{formatPassStatus(review, pass)}</strong>
                    <p>{buildPassSummary(review, pass)}</p>
                  </div>
                  <span>{isExpanded ? 'Hide' : 'Show'}</span>
                </button>
                <AnimatePresence initial={false}>
                  {isExpanded ? (
                    <motion.div
                      className="pass-body"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <div className="meta-stack">
                        <div className="meta-row">
                          <span>Review ID</span>
                          <strong>{pass.reviewId}</strong>
                        </div>
                        <div className="meta-row">
                          <span>Basis</span>
                          <strong>{pass.reviewBasis}</strong>
                        </div>
                        <div className="meta-row">
                          <span>Started</span>
                          <strong>{dateTimeLabel(pass.startedAt)}</strong>
                        </div>
                      </div>

                      {review?.findings.length ? (
                        <div className="inline-findings">
                          <strong>Pass findings</strong>
                          <ul>
                            {review.findings.map((finding, findingIndex) => (
                              <li key={`${pass.reviewId}-finding-${findingIndex}`}>
                                <span className={severityClass(finding.severity)}>{finding.severity}</span>
                                <span>{findingHeading(finding)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {passEvents.length ? (
                        <ol className="timeline-list">
                          {passEvents.map((event, eventIndex) => (
                            <motion.li
                              key={`${event.reviewId}-${event.seq ?? eventIndex}-${event.rawType}`}
                              className="timeline-item"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: Math.min(eventIndex * 0.02, 0.14) }}
                            >
                              <span className={`timeline-state ${event.kind === 'finding' ? 'warning' : 'completed'}`}>
                                {event.kind}
                              </span>
                              <div>
                                <strong>{event.label}</strong>
                                <p>{event.detail}</p>
                              </div>
                            </motion.li>
                          ))}
                        </ol>
                      ) : (
                        <div className="empty-card">Nimbus has not streamed live events for this pass in this browser session yet.</div>
                      )}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.article>
            );
          })}
        </div>
      </section>

      {unresolvedFindings.length > 0 && !isTerminal ? (
        <FindingList
          title="Current unresolved findings"
          findings={unresolvedFindings}
          empty="Nimbus has not published unresolved findings yet."
        />
      ) : null}

      {isTerminal ? (
        <>
          <section className="flow-section">
            <div className="section-header">
              <div>
                <p className="eyebrow">Outcome</p>
                <h2>Session result</h2>
              </div>
            </div>
            <div className="summary-grid">
              <div className="summary-card">
                <span>Outcome</span>
                <strong>{aggregate.session.outcome?.kind.replace(/_/g, ' ') ?? 'Unknown'}</strong>
                <p>{aggregate.session.outcome?.summary ?? currentActivity.summary}</p>
              </div>
              <div className="summary-card">
                <span>Recommendation</span>
                <strong>{aggregate.session.outcome?.recommendation?.replace(/_/g, ' ') ?? 'None'}</strong>
                <p>{aggregate.session.outcome?.unresolved.findingCount ?? unresolvedFindings.length} unresolved finding(s) remain.</p>
              </div>
              <div className="summary-card">
                <span>Changed files</span>
                <strong>{aggregate.session.outcome?.changes.changedFileCount ?? 0}</strong>
                <p>{aggregate.session.outcome?.changes.summaries[0] ?? 'Nimbus did not publish a remediation summary.'}</p>
              </div>
            </div>
          </section>

          <FindingList
            title="Still open"
            findings={unresolvedFindings}
            empty="Nimbus finished without unresolved findings."
          />

          <FindingList
            title="Resolved during this session"
            findings={resolvedFindings}
            empty="Nimbus did not resolve any previously emitted findings in this session."
          />

          <section className="flow-section">
            <div className="section-header">
              <div>
                <p className="eyebrow">Reviewed diff</p>
                <h2>What Nimbus changed</h2>
              </div>
            </div>
            {canShowReviewedDiff && aggregate.reviewedDiff.diff ? (
              <div className="diff-card">
                <div className="diff-meta">
                  <span>{aggregate.reviewedDiff.diff.summary.totalChanged} file(s) changed</span>
                  <span>{aggregate.reviewedDiff.environmentRevision?.changedFileCount ?? 0} file(s) in reviewed revision</span>
                </div>
                {aggregate.reviewedDiff.diff.patch?.trim() ? (
                  <pre>{aggregate.reviewedDiff.diff.patch}</pre>
                ) : (
                  <div className="empty-card">Nimbus has the changed-file summary, but not a patch body for this diff.</div>
                )}
              </div>
            ) : (
              <div className="empty-card">
                {aggregate.reviewedDiff.reason ??
                  'Nimbus finished this session without publishing a remediated worktree diff. This run is findings-only.'}
              </div>
            )}
          </section>

          {primaryEnvironment || canAdopt ? (
            <section className="flow-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Adopt</p>
                  <h2>Bring the reviewed result local</h2>
                </div>
              </div>

              {!primaryEnvironment ? (
                <>
                  <p className="panel-body">
                    Adopting locally creates an isolated worktree for this session so you can run the code and test it yourself before merging anything back.
                  </p>
                  <div className="button-row">
                    <button className="primary-button" onClick={handleAdopt} disabled={!canAdopt || adopting}>
                      {adopting ? 'Adopting locally…' : 'Adopt locally'}
                    </button>
                  </div>
                  {aggregate.adopt.reason ? <p className="panel-subtle">{aggregate.adopt.reason}</p> : null}
                  {adoptError ? (
                    <div className="notice-card error">
                      <strong>Adoption failed</strong>
                      <p>{adoptError}</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="notice-card success">
                  <strong>Local worktree ready</strong>
                  <p>
                    Nimbus created an isolated worktree at <code>{primaryEnvironment.worktreePath ?? 'unknown path'}</code>.
                    Use the command below in your terminal to enter it and test manually.
                  </p>
                  <pre>{primaryEnvironment.enterCommand}</pre>
                </div>
              )}

              {adoptResult ? (
                <div className="notice-card success">
                  <strong>Adoption complete</strong>
                  <p>Local branch <code>{adoptResult.branchName}</code> is ready for manual validation.</p>
                  <pre>{adoptResult.enterCommand}</pre>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="flow-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Next step</p>
                  <h2>No reviewed result to adopt</h2>
                </div>
              </div>
              <div className="empty-card">
                Nimbus did not produce a remediated worktree for this session, so there is nothing to adopt or merge back.
                {unresolvedFindings.length > 0
                  ? ' Address the remaining findings manually, commit that work, then start a new review on the new commit.'
                  : ''}
              </div>
              {aggregate.adopt.reason ? <p className="panel-subtle">{aggregate.adopt.reason}</p> : null}
            </section>
          )}

          {primaryEnvironment ? (
            <section className="flow-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Local diff</p>
                  <h2>Changes in the adopted worktree</h2>
                </div>
              </div>
              {localDiffLoading ? <div className="empty-card">Loading local diff…</div> : null}
              {!localDiffLoading && localDiffError ? (
                <div className="notice-card error">
                  <strong>Local diff failed</strong>
                  <p>{localDiffError}</p>
                </div>
              ) : null}
              {!localDiffLoading && !localDiffError && localDiff ? (
                localDiff.hasDiff ? (
                  <div className="diff-card">
                    <div className="diff-meta">
                      <span>Base ref: {localDiff.baseRef}</span>
                      <span>Branch: {localDiff.entry.branchName}</span>
                    </div>
                    <pre>{localDiff.diff}</pre>
                  </div>
                ) : (
                  <div className="empty-card">No local diff is present. Your adopted worktree matches the target base branch.</div>
                )
              ) : null}
            </section>
          ) : null}

          {primaryEnvironment ? (
            <section className="flow-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">Merge back</p>
                  <h2>Merge the adopted session into your current branch</h2>
                </div>
              </div>
              <p className="panel-body">
                Nimbus will only merge back when you ask it to. Keep your testing in the isolated worktree, then return here and merge when you are satisfied.
              </p>
              <div className="button-row">
                <button className="primary-button" onClick={handleMergeBack} disabled={mergingBack}>
                  {mergingBack ? 'Merging back…' : 'Merge back into current branch'}
                </button>
              </div>
              {mergeBackResult ? (
                <div className="notice-card success">
                  <strong>Merge back {mergeBackResult.status === 'already_applied' ? 'already applied' : 'completed'}</strong>
                  <p>
                    Source branch <code>{mergeBackResult.sourceBranch}</code> was merged into <code>{mergeBackResult.currentBranch}</code>.
                  </p>
                </div>
              ) : null}
              {mergeBackError ? (
                <div className="notice-card error">
                  <strong>Merge back failed</strong>
                  <p>{mergeBackError}</p>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
