import { Navigate, Route, Routes } from 'react-router-dom';
import { StudioLaunchPage } from './features/studio-launch/StudioLaunchPage';
import { StudioSessionPage } from './features/studio-session/StudioSessionPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<StudioLaunchPage />} />
      <Route path="/sessions/:sessionId" element={<StudioSessionPage />} />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
