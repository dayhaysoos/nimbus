import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { sessionRoute } from '../studio/routes';
import { useStudioLaunchController } from './useStudioLaunchController';
import { StudioLaunchScreen } from './StudioLaunchScreen';

const STUDIO_MOCK_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  ((import.meta.env.VITE_STUDIO_MOCK as string | undefined) ?? '').trim().toLowerCase()
);

export function StudioLaunchPage(): JSX.Element {
  const navigate = useNavigate();
  const controller = useStudioLaunchController();

  useEffect(() => {
    if (controller.nextRoutePath) {
      navigate(controller.nextRoutePath);
    }
  }, [controller.nextRoutePath, navigate]);

  if (controller.currentSession) {
    return <Navigate replace to={sessionRoute(controller.currentSession.id)} />;
  }

  return (
    <StudioLaunchScreen
      loading={controller.loading}
      starting={controller.starting}
      launchState={controller.launchState}
      contextRepo={controller.context?.repo ?? controller.preflight?.repo ?? null}
      contextBranch={controller.context?.branch ?? controller.preflight?.branch ?? null}
      preflight={controller.preflight}
      error={controller.error}
      startError={controller.startError}
      startStages={controller.startStages}
      mockEnabled={STUDIO_MOCK_ENABLED}
      onStart={controller.handleStart}
    />
  );
}
