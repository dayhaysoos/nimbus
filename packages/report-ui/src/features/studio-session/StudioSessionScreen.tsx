import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { SessionActivityPanel } from './components/SessionActivityPanel';
import { SessionAdoptPanel } from './components/SessionAdoptPanel';
import { SessionFindingList } from './components/SessionFindingList';
import { SessionLocalDiffPanel } from './components/SessionLocalDiffPanel';
import { SessionMergeBackPanel } from './components/SessionMergeBackPanel';
import { SessionReviewedDiffPanel } from './components/SessionReviewedDiffPanel';
import { SessionWaitingPanel } from './components/SessionWaitingPanel';
import type { EditablePolicyDraft } from './sessionPolicy';
import type { SessionViewModel } from './sessionViewModel';

const ENTIRE_DOCS_URL = 'https://github.com/dayhaysoos/nimbus/blob/main/docs/entire/recovery.md';

export interface StudioSessionScreenProps {
  status: 'loading' | 'unavailable' | 'ready';
  error: string | null;
  viewModel: SessionViewModel | null;
  policyDraft: EditablePolicyDraft;
  onPolicyFieldChange(field: keyof EditablePolicyDraft, value: string): void;
  policyMessage: string | null;
  policyError: string | null;
  submittingPolicy: boolean;
  onApprovePolicy(): void;
  adopting: boolean;
  adoptError: string | null;
  onAdopt(): void;
  localDiffLoading: boolean;
  localDiffError: string | null;
  mergeBackResult: import('../../types').LocalReviewEnvironmentMergeBackResponse | null;
  mergeBackError: string | null;
  mergingBack: boolean;
  onMergeBack(): void;
}

export function StudioSessionScreen(props: StudioSessionScreenProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const motionProps = reduceMotion
    ? { initial: false as const }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.22, ease: 'easeOut' as const },
      };

  if (props.status === 'loading') {
    return (
      <main className="studio-shell">
        <section className="panel-card">
          <p className="eyebrow">Loading</p>
          <h1>Loading review session...</h1>
        </section>
      </main>
    );
  }

  if (props.status === 'unavailable' || !props.viewModel) {
    return (
      <main className="studio-shell">
        <section className="panel-card">
          <p className="eyebrow">Session</p>
          <h1>Review session unavailable</h1>
          <p className="panel-body">{props.error ?? 'Nimbus could not load the requested session.'}</p>
          <Link className="inline-link" to="/">
            Back to launch
          </Link>
        </section>
      </main>
    );
  }

  const viewModel = props.viewModel;

  return (
    <main className="studio-shell session-shell">
      <motion.section className="panel-card session-stage-card" {...motionProps}>
        <div className="panel-header session-stage-header">
          <div>
            <p className="eyebrow">Review session</p>
            <h1 className="session-title">{viewModel.stageTitle}</h1>
            <p className="launch-subline">{viewModel.repoBranchLabel}</p>
          </div>
          <div className="session-stage-actions">
            <span className={`launch-status ${viewModel.stageTone}`}>{viewModel.phaseLabel}</span>
            <Link className="inline-link" to="/">
              Back to launch
            </Link>
          </div>
        </div>
        <p className="panel-body">{viewModel.stageDetail}</p>
      </motion.section>

      {viewModel.showBasicModeNotice ? (
        <motion.section className="notice-card warning" {...motionProps}>
          <strong>Basic-mode session</strong>
          <p>Nimbus is reviewing the latest commit without Entire-backed intent context.</p>
          <a className="inline-link" href={ENTIRE_DOCS_URL} target="_blank" rel="noreferrer">
            Learn more about Entire
          </a>
        </motion.section>
      ) : null}

      {props.error ? (
        <section className="notice-card error">
          <strong>Live session error</strong>
          <p>{props.error}</p>
        </section>
      ) : null}

      {viewModel.isWaitingOnHuman ? (
        <motion.section className="panel-card session-human-step-card" {...motionProps}>
          <SessionWaitingPanel
            editable={viewModel.policy.editable}
            policyDraft={props.policyDraft}
            onPolicyFieldChange={props.onPolicyFieldChange}
            submitting={props.submittingPolicy}
            policyMessage={props.policyMessage}
            policyError={props.policyError}
            onApprove={props.onApprovePolicy}
          />
        </motion.section>
      ) : null}

      {!viewModel.isTerminal ? (
        <div className="session-live-grid">
          <motion.section className="flow-section session-console-section" {...motionProps}>
            <div className="section-header">
              <div>
                <p className="eyebrow">Session activity</p>
                <h2>{viewModel.activity.heading}</h2>
              </div>
            </div>
            <SessionActivityPanel activity={viewModel.activity} />
          </motion.section>

          <motion.section className="flow-section session-findings-section" {...motionProps}>
            <div className="section-header">
              <div>
                <p className="eyebrow">Findings</p>
                <h2>What Nimbus has surfaced</h2>
              </div>
            </div>
            <p className="panel-subtle">{viewModel.findings.liveSubtle}</p>
            <div className="session-findings-scroll">
              {viewModel.findings.unresolved.length === 0 ? (
                <div className="empty-card">No findings have materialized yet.</div>
              ) : (
                <div className="finding-list session-finding-list">
                  {viewModel.findings.unresolved.map((finding) => (
                    <article key={finding.key} className="finding-card">
                      <div className="finding-header">
                        <span className={finding.severityClass}>{finding.severity}</span>
                        {finding.location ? <span className="finding-location">{finding.location}</span> : null}
                      </div>
                      <strong>{finding.heading}</strong>
                      {finding.description ? <p>{finding.description}</p> : null}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </motion.section>
        </div>
      ) : (
        <>
          {viewModel.result ? (
            <motion.section className="flow-section" {...motionProps}>
              <div className="section-header">
                <div>
                  <p className="eyebrow">Outcome</p>
                  <h2>Session result</h2>
                </div>
              </div>
              <div className="session-result-grid">
                <div className="session-result-card">
                  <span>Outcome</span>
                  <strong>{viewModel.result.outcomeLabel}</strong>
                  <p>{viewModel.result.summary}</p>
                </div>
                <div className="session-result-card">
                  <span>Recommendation</span>
                  <strong>{viewModel.result.recommendation}</strong>
                  <p>{viewModel.result.unresolvedCount} unresolved finding(s) remain.</p>
                </div>
                <div className="session-result-card">
                  <span>Changed files</span>
                  <strong>{viewModel.result.changedFiles}</strong>
                  <p>{viewModel.result.changedSummary}</p>
                </div>
              </div>
            </motion.section>
          ) : null}

          <motion.section className="flow-section" {...motionProps}>
            <div className="section-header">
              <div>
                <p className="eyebrow">Reviewed diff</p>
                <h2>What Nimbus changed</h2>
              </div>
            </div>
            <SessionReviewedDiffPanel reviewedDiff={viewModel.reviewedDiff} />
          </motion.section>

          <motion.section className="flow-section" {...motionProps}>
            <SessionAdoptPanel
              adopt={viewModel.adopt}
              adopting={props.adopting}
              adoptError={props.adoptError}
              onAdopt={props.onAdopt}
            />
          </motion.section>

          {viewModel.localDiff.visible ? (
            <motion.section className="flow-section" {...motionProps}>
              <div className="section-header">
                <div>
                  <p className="eyebrow">Local diff</p>
                  <h2>Changes in the adopted worktree</h2>
                </div>
              </div>
              <SessionLocalDiffPanel
                loading={props.localDiffLoading}
                error={props.localDiffError}
                localDiff={viewModel.localDiff.data}
              />
            </motion.section>
          ) : null}

          {viewModel.mergeBack.visible ? (
            <motion.section className="flow-section" {...motionProps}>
              <SessionMergeBackPanel
                mergingBack={props.mergingBack}
                mergeBackResult={props.mergeBackResult}
                mergeBackError={props.mergeBackError}
                onMergeBack={props.onMergeBack}
              />
            </motion.section>
          ) : null}

          <SessionFindingList
            title="Still open"
            findings={viewModel.findings.unresolved}
            empty="Nimbus finished without unresolved findings."
          />

          <SessionFindingList
            title="Resolved during this session"
            findings={viewModel.findings.resolved}
            empty="Nimbus did not resolve any previously emitted findings in this session."
          />

          <motion.section className="flow-section session-console-section" {...motionProps}>
            <div className="section-header">
              <div>
                <p className="eyebrow">Session activity</p>
                <h2>{viewModel.activity.heading}</h2>
              </div>
            </div>
            <SessionActivityPanel activity={viewModel.activity} />
          </motion.section>
        </>
      )}
    </main>
  );
}
