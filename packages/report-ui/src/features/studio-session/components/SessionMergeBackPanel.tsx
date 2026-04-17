import type { LocalReviewEnvironmentMergeBackResponse } from '../../../types';

export function SessionMergeBackPanel(props: {
  mergingBack: boolean;
  mergeBackResult: LocalReviewEnvironmentMergeBackResponse | null;
  mergeBackError: string | null;
  onMergeBack(): void;
}): JSX.Element {
  return (
    <>
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
        <button className="primary-button" onClick={props.onMergeBack} disabled={props.mergingBack}>
          {props.mergingBack ? 'Merging back...' : 'Merge back into current branch'}
        </button>
      </div>
      {props.mergeBackResult ? (
        <div className="notice-card success">
          <strong>Merge back {props.mergeBackResult.status === 'already_applied' ? 'already applied' : 'completed'}</strong>
          <p>
            Source branch <code>{props.mergeBackResult.sourceBranch}</code> was merged into <code>{props.mergeBackResult.currentBranch}</code>.
          </p>
        </div>
      ) : null}
      {props.mergeBackError ? (
        <div className="notice-card error">
          <strong>Merge back failed</strong>
          <p>{props.mergeBackError}</p>
        </div>
      ) : null}
    </>
  );
}
