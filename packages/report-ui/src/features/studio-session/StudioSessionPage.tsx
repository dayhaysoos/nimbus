import { useParams } from 'react-router-dom';
import { StudioSessionScreen } from './StudioSessionScreen';
import { useStudioSessionController } from './useStudioSessionController';

export function StudioSessionPage(): JSX.Element {
  const { sessionId } = useParams();
  const controller = useStudioSessionController(sessionId);

  return (
    <StudioSessionScreen
      status={controller.status}
      error={controller.error}
      viewModel={controller.viewModel}
      policyDraft={controller.policyDraft}
      onPolicyFieldChange={controller.setPolicyField}
      policyMessage={controller.policyMessage}
      policyError={controller.policyError}
      submittingPolicy={controller.submittingPolicy}
      onApprovePolicy={() => {
        void controller.handleApprovePolicy();
      }}
      adopting={controller.adopting}
      adoptError={controller.adoptError}
      onAdopt={() => {
        void controller.handleAdopt();
      }}
      localDiffLoading={controller.localDiffLoading}
      localDiffError={controller.localDiffError}
      mergeBackResult={controller.mergeBackResult}
      mergeBackError={controller.mergeBackError}
      mergingBack={controller.mergingBack}
      onMergeBack={() => {
        void controller.handleMergeBack();
      }}
    />
  );
}
