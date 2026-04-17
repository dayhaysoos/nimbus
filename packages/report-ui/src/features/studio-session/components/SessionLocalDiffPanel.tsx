import type { LocalReviewEnvironmentDiffResponse } from '../../../types';

export function SessionLocalDiffPanel(props: {
  loading: boolean;
  error: string | null;
  localDiff: LocalReviewEnvironmentDiffResponse | null;
}): JSX.Element {
  if (props.loading) {
    return <div className="empty-card">Loading local diff...</div>;
  }
  if (props.error) {
    return (
      <div className="notice-card error">
        <strong>Local diff failed</strong>
        <p>{props.error}</p>
      </div>
    );
  }
  if (!props.localDiff) {
    return <div className="empty-card">Loading local diff...</div>;
  }
  if (!props.localDiff.hasDiff) {
    return <div className="empty-card">No local diff is present. Your adopted worktree matches the target base branch.</div>;
  }
  return (
    <div className="diff-card session-diff-card">
      <div className="diff-meta">
        <span>Base ref: {props.localDiff.baseRef}</span>
        <span>Branch: {props.localDiff.entry.branchName}</span>
      </div>
      <pre>{props.localDiff.diff}</pre>
    </div>
  );
}
