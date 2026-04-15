import { Navigate, Route, Routes } from 'react-router-dom';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';
import { ReviewSessionPage } from './components/ReviewSessionPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<ReviewHistoryPage />} />
      <Route path="/sessions/:sessionId" element={<ReviewSessionPage />} />
      <Route path="/sessions/:sessionId/reports/:reviewId" element={<ReviewSessionPage />} />
      <Route path="/branches/:repo/:branch/sessions/:sessionId" element={<ReviewSessionPage />} />
      <Route path="/branches/:repo/:branch/sessions/:sessionId/reports/:reviewId" element={<ReviewSessionPage />} />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
