import { motion, useReducedMotion } from 'framer-motion';
import type { SessionFindingViewModel } from '../sessionViewModel';

export function SessionFindingList(props: {
  title: string;
  empty: string;
  findings: SessionFindingViewModel[];
}): JSX.Element {
  const reduceMotion = useReducedMotion();

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
              key={finding.key}
              className="finding-card"
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? undefined : { delay: Math.min(index * 0.03, 0.18) }}
            >
              <div className="finding-header">
                <span className={finding.severityClass}>{finding.severity}</span>
                {finding.location ? <span className="finding-location">{finding.location}</span> : null}
              </div>
              <strong>{finding.heading}</strong>
              {finding.description ? <p>{finding.description}</p> : null}
              {finding.suggestedFix ? (
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
