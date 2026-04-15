import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  dateTimeLabel,
  parseListReviewSessionsResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartStreamEvent,
} from '../lib/review';
import type {
  ReviewSessionResponse,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartStageEvent,
} from '../types';

const API_BASE = (import.meta.env.VITE_NIMBUS_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const ENTIRE_DOCS_URL = 'https://github.com/dayhaysoos/nimbus/blob/main/docs/entire/recovery.md';
const LAST_CHECKPOINTS = 1;
const HOME_REFRESH_INTERVAL_MS = 3_000;

interface StartStageState {
  stage: StudioNewReviewStartStageEvent['stage'];
  label: string;
  detail: string;
  state: 'active' | 'completed';
}

function isTerminalPhase(phase: ReviewSessionResponse['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

function sessionRoute(session: Pick<ReviewSessionResponse, 'id' | 'repo' | 'branch'>): string {
  return `/branches/${encodeURIComponent(session.repo)}/${encodeURIComponent(session.branch)}/sessions/${encodeURIComponent(
    session.id
  )}`;
}

function pickCurrentCommitSession(
  sessions: ReviewSessionResponse[],
  commitSha: string | null | undefined
): ReviewSessionResponse | null {
  if (!commitSha) {
    return null;
  }
  return (
    sessions
      .filter((session) => session.anchorCommitSha === commitSha)
      .slice()
      .sort((left, right) => {
        const terminalDelta = Number(isTerminalPhase(left.phase)) - Number(isTerminalPhase(right.phase));
        if (terminalDelta !== 0) {
          return terminalDelta;
        }
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })[0] ?? null
  );
}

function currentSessionHeadline(session: ReviewSessionResponse): string {
  if (session.phase === 'waiting_on_human') {
    return 'Nimbus is waiting on a human decision for this commit.';
  }
  if (isTerminalPhase(session.phase)) {
    return 'This commit already has a review session.';
  }
  return 'Nimbus is already reviewing this commit.';
}

function currentSessionDetail(session: ReviewSessionResponse): string {
  if (session.phase === 'waiting_on_human') {
    return 'Studio stays pinned to this session until policy approval or another required decision is made.';
  }
  if (isTerminalPhase(session.phase)) {
    if (session.outcome?.materializeReady) {
      return 'Continue from the session page to inspect the reviewed diff, adopt locally, test, and merge back before starting anything new.';
    }
    return 'This commit has already been reviewed. Studio will not create another session for the same commit.';
  }
  return 'Studio follows the current commit only. Open the existing session to watch passes, events, and findings as they evolve.';
}

function modeLabel(preflight: StudioNewReviewPreflightResponse | null): string {
  if (!preflight) {
    return 'Checking review mode';
  }
  if (preflight.startability === 'intent_aware') {
    return 'Intent-aware review';
  }
  if (preflight.startability === 'basic') {
    return 'Basic review';
  }
  return 'Review unavailable';
}

function modeHeadline(preflight: StudioNewReviewPreflightResponse | null): string {
  if (!preflight) {
    return 'Checking the current commit';
  }
  if (preflight.startability === 'intent_aware') {
    return 'Entire context is ready for this review.';
  }
  if (preflight.startability === 'basic') {
    return 'Entire context is unavailable, so Nimbus will fall back to a basic review.';
  }
  return 'Nimbus cannot start a session from this checkout yet.';
}

function modeDetail(preflight: StudioNewReviewPreflightResponse | null): string {
  if (!preflight) {
    return 'Nimbus is verifying the current branch and commit context.';
  }
  if (preflight.startability === 'intent_aware') {
    return 'Nimbus will review the current commit with Entire-backed session context.';
  }
  if (preflight.startability === 'basic') {
    return 'Nimbus will still review the current commit, but without Entire-derived intent context.';
  }
  return preflight.blockingIssues[0]?.message ?? preflight.error?.message ?? 'Studio could not resolve a startable review target.';
}

async function fetchJson(input: string): Promise<unknown> {
  const response = await fetch(input, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

export function ReviewHistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const startSourceRef = useRef<EventSource | null>(null);
  const hasLoadedHomeRef = useRef(false);
  const [context, setContext] = useState<StudioContextResponse | null>(null);
  const [preflight, setPreflight] = useState<StudioNewReviewPreflightResponse | null>(null);
  const [currentSession, setCurrentSession] = useState<ReviewSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startStages, setStartStages] = useState<StartStageState[]>([]);
  const [startError, setStartError] = useState<string | null>(null);

  const loadHome = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background === true;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const [rawContext, rawPreflight] = await Promise.all([
        fetchJson(`${API_BASE}/api/studio/context`),
        fetchJson(`${API_BASE}/api/studio/new-review/preflight?lastCheckpoints=${LAST_CHECKPOINTS}`),
      ]);

      const parsedContext = parseStudioContextResponse(rawContext);
      const parsedPreflight = parseStudioNewReviewPreflightResponse(rawPreflight);
      setContext(parsedContext);
      setPreflight(parsedPreflight);

      if (parsedContext.repo && parsedContext.branch) {
        const rawSessions = await fetchJson(
          `${API_BASE}/api/review-sessions?limit=20&repo=${encodeURIComponent(parsedContext.repo)}&branch=${encodeURIComponent(parsedContext.branch)}`
        );
        const parsedSessions = parseListReviewSessionsResponse(rawSessions);
        setCurrentSession(pickCurrentCommitSession(parsedSessions.sessions, parsedPreflight.commitSha));
      } else {
        setCurrentSession(null);
      }
      hasLoadedHomeRef.current = true;
      setError(null);
    } catch (loadError) {
      if (!background || !hasLoadedHomeRef.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadHome();
    return () => {
      startSourceRef.current?.close();
      startSourceRef.current = null;
    };
  }, [loadHome]);

  useEffect(() => {
    const refreshHome = (): void => {
      if (starting) {
        return;
      }
      void loadHome({ background: true });
    };

    const timer = window.setInterval(refreshHome, HOME_REFRESH_INTERVAL_MS);
    const handleWindowFocus = (): void => {
      refreshHome();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        refreshHome();
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadHome, starting]);

  useEffect(() => {
    if (loading || starting || !currentSession) {
      return;
    }
    navigate(sessionRoute(currentSession), { replace: true });
  }, [currentSession, loading, navigate, starting]);

  const canStart = preflight?.capabilities.canStart === true;
  const hasRepoContext = Boolean(context?.repo && context?.branch);
  const checks = preflight?.checks ?? [];

  const launchSummary = useMemo(() => {
    if (!context?.repo || !context.branch) {
      return 'Open Review Studio from inside a git repository to launch a session.';
    }
    if (currentSession) {
      return `Nimbus is already tracking the current commit on ${context.branch}. Continue that session instead of creating another review.`;
    }
    return `Nimbus will review the last committed state on ${context.branch}.`;
  }, [context, currentSession]);

  const handleStart = useCallback(() => {
    if (!context?.repo || !context.branch) {
      setStartError('Studio could not detect the current repository and branch.');
      return;
    }

    startSourceRef.current?.close();
    setStarting(true);
    setStartError(null);
    setStartStages([]);

    const params = new URLSearchParams({
      policyMode: 'auto',
      lastCheckpoints: String(LAST_CHECKPOINTS),
      repo: context.repo,
      branch: context.branch,
    });
    const source = new EventSource(`${API_BASE}/api/studio/new-review/start/events?${params.toString()}`);
    startSourceRef.current = source;

    const handleMessage = (messageEvent: MessageEvent<string>): void => {
      try {
        const event = parseStudioNewReviewStartStreamEvent(JSON.parse(messageEvent.data) as unknown);
        if (event.type === 'stage') {
          setStartStages((current) => {
            const next = [...current];
            const existingIndex = next.findIndex((entry) => entry.stage === event.stage);
            const nextEntry: StartStageState = {
              stage: event.stage,
              label: event.label,
              detail: event.detail,
              state: event.state,
            };
            if (existingIndex >= 0) {
              next.splice(existingIndex, 1, nextEntry);
              return next;
            }
            return [...next, nextEntry];
          });
          return;
        }

        if (event.type === 'completed') {
          setStarting(false);
          startSourceRef.current?.close();
          startSourceRef.current = null;
          navigate(event.routePath);
          return;
        }

        setStarting(false);
        setStartError(event.message);
      } catch (parseError) {
        setStarting(false);
        setStartError(parseError instanceof Error ? parseError.message : String(parseError));
      }
    };

    const handleTransportError = (): void => {
      if (!startSourceRef.current) {
        return;
      }
      setStarting(false);
      setStartError('The launch stream disconnected before Nimbus could start the session.');
      startSourceRef.current.close();
      startSourceRef.current = null;
    };

    source.addEventListener('message', handleMessage);
    source.addEventListener('error', handleTransportError);
  }, [context, navigate]);

  if (currentSession) {
    return (
      <main className="studio-shell">
        <motion.section
          className="hero-card"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="hero-copy">
            <p className="eyebrow">Nimbus Review Studio</p>
            <h1>Continue the current review session.</h1>
            <p className="hero-body">{launchSummary}</p>
          </div>
          <div className="hero-meta">
            <div className="meta-chip">
              <span>Repository</span>
              <strong>{context?.repo ?? currentSession.repo}</strong>
            </div>
            <div className="meta-chip">
              <span>Branch</span>
              <strong>{context?.branch ?? currentSession.branch}</strong>
            </div>
            <div className="meta-chip">
              <span>Session</span>
              <strong>{currentSession.id}</strong>
            </div>
            <div className="meta-chip">
              <span>Phase</span>
              <strong>{currentSession.phase.replace(/_/g, ' ')}</strong>
            </div>
          </div>
        </motion.section>

        <motion.section
          className="panel-card"
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.3, ease: 'easeOut' }}
        >
          <div className="panel-header">
            <div>
              <p className="eyebrow">Current session</p>
              <h2>{currentSessionHeadline(currentSession)}</h2>
            </div>
            <span className={`status-pill ${isTerminalPhase(currentSession.phase) ? 'terminal' : currentSession.phase === 'waiting_on_human' ? 'waiting' : 'live'}`}>
              {currentSession.phase.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="panel-body">{currentSessionDetail(currentSession)}</p>

          <div className="meta-stack">
            <div className="meta-row">
              <span>Target commit</span>
              <strong>{currentSession.anchorCommitSha?.slice(0, 12) ?? preflight?.commitSha?.slice(0, 12) ?? 'Unknown'}</strong>
            </div>
            <div className="meta-row">
              <span>Passes</span>
              <strong>{currentSession.passCount}</strong>
            </div>
            <div className="meta-row">
              <span>Updated</span>
              <strong>{dateTimeLabel(currentSession.updatedAt)}</strong>
            </div>
          </div>

          <div className="button-row">
            <button className="primary-button" onClick={() => navigate(sessionRoute(currentSession))}>
              Open current session
            </button>
          </div>

          {error ? (
            <div className="notice-card error">
              <strong>Background refresh failed</strong>
              <p>{error}</p>
            </div>
          ) : null}
        </motion.section>
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
          <p className="eyebrow">Nimbus Review Studio</p>
          <h1>Start a review session on the current commit.</h1>
          <p className="hero-body">{launchSummary}</p>
        </div>
        <div className="hero-meta">
          <div className="meta-chip">
            <span>Repository</span>
            <strong>{context?.repo ?? 'Not detected'}</strong>
          </div>
          <div className="meta-chip">
            <span>Branch</span>
            <strong>{context?.branch ?? 'Not detected'}</strong>
          </div>
          <div className="meta-chip">
            <span>Mode</span>
            <strong>{modeLabel(preflight)}</strong>
          </div>
        </div>
      </motion.section>

      <div className="studio-grid">
        <motion.section
          className="panel-card"
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.3, ease: 'easeOut' }}
        >
          <div className="panel-header">
            <div>
              <p className="eyebrow">Launch</p>
              <h2>New review session</h2>
            </div>
            {loading ? <span className="status-pill muted">Loading</span> : null}
          </div>
          <p className="panel-body">
            {modeHeadline(preflight)}
          </p>
          <p className="panel-subtle">{modeDetail(preflight)}</p>

          <div className="button-row">
            <button className="primary-button" onClick={handleStart} disabled={!canStart || !hasRepoContext || starting || loading}>
              {starting ? 'Launching review…' : 'New review session'}
            </button>
          </div>

          <AnimatePresence initial={false}>
            {startError ? (
              <motion.div
                key="start-error"
                className="notice-card error"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <strong>Launch failed</strong>
                <p>{startError}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {starting ? (
              <motion.div
                key="start-progress"
                className="timeline-card"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <div className="timeline-heading">
                  <strong>Starting the session</strong>
                  <span>Nimbus is resolving context, creating the review, and opening the session flow.</span>
                </div>
                <ol className="timeline-list">
                  {startStages.map((stage, index) => (
                    <motion.li
                      key={stage.stage}
                      className="timeline-item"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.04 }}
                    >
                      <span className={`timeline-state ${stage.state}`}>{stage.state === 'completed' ? 'Done' : 'Live'}</span>
                      <div>
                        <strong>{stage.label}</strong>
                        <p>{stage.detail}</p>
                      </div>
                    </motion.li>
                  ))}
                </ol>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {preflight?.startability === 'basic' ? (
            <div className="notice-card warning">
              <strong>Basic review fallback</strong>
              <p>
                Entire is optional now. Nimbus will keep going in basic mode, but if you want higher-quality context,
                restore Entire first.
              </p>
              <a className="inline-link" href={ENTIRE_DOCS_URL} target="_blank" rel="noreferrer">
                Learn more about Entire
              </a>
            </div>
          ) : null}

          {error ? (
            <div className="notice-card error">
              <strong>Studio failed to load</strong>
              <p>{error}</p>
            </div>
          ) : null}
        </motion.section>

        <motion.section
          className="panel-card"
          initial={{ opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.3, ease: 'easeOut' }}
        >
          <div className="panel-header">
            <div>
              <p className="eyebrow">Preflight</p>
              <h2>Context check</h2>
            </div>
          </div>

          <div className="check-grid">
            {checks.map((check) => (
              <div key={check.code} className={`check-card ${check.ok ? 'ok' : 'warning'}`}>
                <div className="check-card-header">
                  <strong>{check.label}</strong>
                  <span>{check.ok ? 'Ready' : 'Attention'}</span>
                </div>
                <p>{check.detail}</p>
              </div>
            ))}
          </div>

          <div className="meta-stack">
            <div className="meta-row">
              <span>Target commit</span>
              <strong>{preflight?.commitSha?.slice(0, 12) ?? 'Not available'}</strong>
            </div>
            <div className="meta-row">
              <span>Checkpoint window</span>
              <strong>{preflight ? `Last ${preflight.effectiveLastCheckpoints}` : 'Checking'}</strong>
            </div>
            <div className="meta-row">
              <span>Detected at</span>
              <strong>{dateTimeLabel(context?.detectedAt ?? null)}</strong>
            </div>
          </div>
        </motion.section>
      </div>
    </main>
  );
}
