import { Route, Routes } from 'react-router-dom';
import { ReportPage } from './components/ReportPage';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';
import { BranchReviewsPage } from './components/BranchReviewsPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<ReviewHistoryPage />} />
      <Route path="/branches/:repo/:branch" element={<BranchReviewsPage />} />
      <Route path="/branches/:repo/:branch/reports/:reviewId" element={<ReportPage />} />
      <Route path="/branches/:repo/:branch/policy/:reviewId" element={<ReportPage />} />
      <Route path="/policy/:reviewId" element={<ReportPage />} />
      <Route path="/reports/:reviewId" element={<ReportPage />} />
      <Route path="*" element={<ReviewHistoryPage />} />
    </Routes>
  );
}
