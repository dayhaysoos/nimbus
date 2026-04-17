import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { launchStateLabel, launchSupportCopy, modeLabel, preflightSignalLabel } from './launchViewModel';
import type { StudioNewReviewPreflightResponse, StudioNewReviewStartStageEvent } from '../../types';

const ENTIRE_DOCS_URL = 'https://github.com/dayhaysoos/nimbus/blob/main/docs/entire/recovery.md';

export interface StudioLaunchScreenProps {
  loading: boolean;
  starting: boolean;
  launchState: 'checking' | 'ready' | 'basic' | 'blocked' | 'starting';
  contextRepo: string | null;
  contextBranch: string | null;
  preflight: StudioNewReviewPreflightResponse | null;
  error: string | null;
  startError: string | null;
  startStages: StudioNewReviewStartStageEvent[];
  mockEnabled: boolean;
  onStart(): void;
}

export function StudioLaunchScreen(props: StudioLaunchScreenProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion
    ? { initial: false as const }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2, ease: 'easeOut' as const },
      };

  const hasRepoContext = Boolean(props.contextRepo && props.contextBranch);
  const canStart = props.preflight?.capabilities.canStart === true;
  const repoBranchLabel = hasRepoContext
    ? `${props.contextRepo} · ${props.contextBranch}`
    : 'Git context not detected';
  const launchSupport = launchSupportCopy(props.launchState, {
    hasRepoContext,
    preflight: props.preflight,
    error: props.error,
  });

  return (
    <main className="studio-shell launch-shell">
      <motion.section className="panel-card launch-panel launch-control-panel" {...motionProps}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">Nimbus Review Studio</p>
            <h1 className="launch-title">Review latest commit</h1>
            <p className="launch-subline">{repoBranchLabel}</p>
          </div>
          <div className="launch-state-actions">
            <span className={`launch-status ${props.launchState}`}>{launchStateLabel(props.launchState)}</span>
            {canStart && hasRepoContext && !props.starting ? (
              <button className="primary-button launch-primary-button" onClick={props.onStart} disabled={props.loading}>
                Start review session
              </button>
            ) : null}
          </div>
        </div>

        {launchSupport ? <p className="panel-body">{launchSupport}</p> : null}

        <div className="launch-signal-row">
          <div className={`launch-signal ${props.launchState}`}>
            <span>Preflight</span>
            <strong>{preflightSignalLabel(props.launchState)}</strong>
          </div>
          <div
            className={`launch-signal ${
              props.preflight?.startability === 'intent_aware'
                ? 'ready'
                : props.preflight?.startability === 'basic'
                  ? 'basic'
                  : props.launchState
            }`}
          >
            <span>Entire context</span>
            <strong>{modeLabel(props.preflight)}</strong>
          </div>
        </div>

        {props.preflight?.startability === 'basic' ? (
          <p className="launch-inline-note">
            Entire context was not found. Nimbus can still start a basic review.
            {' '}
            <a className="inline-link" href={ENTIRE_DOCS_URL} target="_blank" rel="noreferrer">
              Learn more
            </a>
          </p>
        ) : null}

        {props.mockEnabled ? (
          <p className="launch-inline-note">
            Mock mode is enabled. The launch flow uses the same route and screen model as live data.
          </p>
        ) : null}

        <AnimatePresence initial={false}>
          {props.startError ? (
            <motion.div
              key="start-error"
              className="notice-card error"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            >
              <strong>Launch failed</strong>
              <p>{props.startError}</p>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {props.starting ? (
            <motion.div
              key="start-progress"
              className="timeline-card launch-progress"
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            >
              <div className="timeline-heading">
                <strong>Starting review</strong>
                <span>Nimbus is resolving context, creating the review, and routing into the session.</span>
              </div>
              <ol className="timeline-list">
                {props.startStages.map((stage, index) => (
                  <motion.li
                    key={stage.stage}
                    className="timeline-item"
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reduceMotion ? undefined : { delay: index * 0.03, duration: 0.16 }}
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

        {props.error && props.preflight ? (
          <div className="notice-card error">
            <strong>Background refresh failed</strong>
            <p>{props.error}</p>
          </div>
        ) : null}
      </motion.section>
    </main>
  );
}
