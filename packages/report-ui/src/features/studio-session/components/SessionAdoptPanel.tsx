import type { SessionViewModel } from '../sessionViewModel';

export function SessionAdoptPanel(props: {
  adopt: SessionViewModel['adopt'];
  adopting: boolean;
  adoptError: string | null;
  onAdopt(): void;
}): JSX.Element {
  if (props.adopt.noAdoptVisible) {
    return (
      <>
        <div className="section-header">
          <div>
            <p className="eyebrow">Next step</p>
            <h2>{props.adopt.noAdoptTitle}</h2>
          </div>
        </div>
        <div className={`notice-card ${props.adopt.noAdoptTitle === 'No reviewed result' ? 'error' : 'warning'}`}>
          <strong>{props.adopt.noAdoptTitle}</strong>
          <p>{props.adopt.noAdoptDetail}</p>
        </div>
        {props.adopt.reason ? <p className="panel-subtle">{props.adopt.reason}</p> : null}
      </>
    );
  }

  return (
    <>
      <div className="section-header">
        <div>
          <p className="eyebrow">Adopt</p>
          <h2>Bring the reviewed result local</h2>
        </div>
      </div>
      {!props.adopt.hasLocalEnvironment ? (
        <>
          <p className="panel-body">
            Adopting locally creates an isolated worktree for this reviewed result so you can run the code and test it yourself before merging anything back.
          </p>
          <div className="button-row">
            <button className="primary-button" onClick={props.onAdopt} disabled={!props.adopt.canAdopt || props.adopting}>
              {props.adopting ? 'Adopting locally...' : 'Adopt locally'}
            </button>
          </div>
          {props.adopt.reason ? <p className="panel-subtle">{props.adopt.reason}</p> : null}
          {props.adoptError ? (
            <div className="notice-card error">
              <strong>Adoption failed</strong>
              <p>{props.adoptError}</p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="notice-card success">
          <strong>Local worktree ready</strong>
          <p>
            Nimbus created an isolated worktree at <code>{props.adopt.primaryEnvironment?.worktreePath ?? 'unknown path'}</code>.
            Use the command below in your terminal to enter it and test manually.
          </p>
          <pre>{props.adopt.primaryEnvironment?.enterCommand}</pre>
        </div>
      )}

      {props.adopt.adoptResult ? (
        <div className="notice-card success">
          <strong>Adoption complete</strong>
          <p>Local branch <code>{props.adopt.adoptResult.branchName}</code> is ready for manual validation.</p>
          <pre>{props.adopt.adoptResult.enterCommand}</pre>
        </div>
      ) : null}
    </>
  );
}
