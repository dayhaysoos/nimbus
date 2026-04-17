import { useEffect, useRef } from 'react';
import { activityConsoleKindLabel, formatActivityConsoleTimestamp } from '../sessionViewModel';
import type { SessionViewModel } from '../sessionViewModel';

export function SessionActivityPanel(props: { activity: SessionViewModel['activity'] }): JSX.Element {
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = consoleRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [props.activity.entries.length]);

  return (
    <div className="activity-console-card">
      <div className="activity-console-toolbar">
        <div>
          <strong>Review stream</strong>
          <p className="panel-subtle">{props.activity.subtle}</p>
        </div>
        <div className="activity-console-toolbar-meta">
          <span>{props.activity.passCountLabel}</span>
          <span>{props.activity.modeLabel}</span>
          <span className={`status-pill ${props.activity.streamLabel === 'live tail' ? 'live' : 'muted'}`}>
            {props.activity.streamLabel}
          </span>
        </div>
      </div>
      <div className="activity-console-window" ref={consoleRef} aria-live="polite">
        {props.activity.entries.map((entry) => (
          <div key={entry.id} className={`activity-console-line ${entry.kind} ${entry.checkpoint ? 'checkpoint' : ''}`}>
            <div className="activity-console-meta">
              <span>{formatActivityConsoleTimestamp(entry.createdAt)}</span>
              {entry.passIndex !== null ? <span>{`pass ${entry.passIndex + 1}`}</span> : null}
              <span>{activityConsoleKindLabel(entry.kind)}</span>
              {entry.checkpoint ? <span className="activity-console-tag">Pause point</span> : null}
            </div>
            <div className="activity-console-body">{entry.line}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
