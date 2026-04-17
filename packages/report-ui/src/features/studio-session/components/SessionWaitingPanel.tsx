import type { EditablePolicyDraft } from '../sessionPolicy';

export function SessionWaitingPanel(props: {
  editable: boolean;
  policyDraft: EditablePolicyDraft;
  onPolicyFieldChange(field: keyof EditablePolicyDraft, value: string): void;
  submitting: boolean;
  policyMessage: string | null;
  policyError: string | null;
  onApprove(): void;
}): JSX.Element {
  return (
    <>
      <div className="section-header">
        <div>
          <p className="eyebrow">Human step</p>
          <h2>{props.editable ? 'Approve the review policy' : 'Nimbus is waiting on you'}</h2>
        </div>
      </div>
      <p className="panel-body">
        {props.editable
          ? 'Nimbus paused before continuing remediation. Review the policy, edit it if needed, then approve it to resume the session. Nimbus will continue in an isolated review workspace, not your current checkout.'
          : 'Nimbus paused and is waiting for a human decision before it can continue.'}
      </p>
      {props.editable ? (
        <>
          <div className="policy-grid">
            <label className="field-stack">
              <span>Goal</span>
              <textarea
                value={props.policyDraft.goal}
                onChange={(event) => props.onPolicyFieldChange('goal', event.target.value)}
                rows={3}
              />
            </label>
            <label className="field-stack">
              <span>Prohibitions</span>
              <textarea
                value={props.policyDraft.prohibitions}
                onChange={(event) => props.onPolicyFieldChange('prohibitions', event.target.value)}
                rows={5}
              />
            </label>
            <label className="field-stack">
              <span>Constraints</span>
              <textarea
                value={props.policyDraft.constraints}
                onChange={(event) => props.onPolicyFieldChange('constraints', event.target.value)}
                rows={5}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={props.onApprove} disabled={props.submitting}>
              {props.submitting ? 'Approving policy...' : 'Approve policy'}
            </button>
          </div>
        </>
      ) : null}
      {props.policyMessage ? (
        <div className="notice-card success">
          <strong>Policy approved</strong>
          <p>{props.policyMessage}</p>
        </div>
      ) : null}
      {props.policyError ? (
        <div className="notice-card error">
          <strong>Approval failed</strong>
          <p>{props.policyError}</p>
        </div>
      ) : null}
    </>
  );
}
