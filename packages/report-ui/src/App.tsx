import { Route, Routes } from 'react-router-dom';
import { ReportPage } from './components/ReportPage';
import { PolicyPage } from './components/PolicyPage';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';
import { BranchReviewsPage } from './components/BranchReviewsPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<ReviewHistoryPage />} />
      <Route path="/branches/:repo/:branch" element={<BranchReviewsPage />} />
      <Route path="/branches/:repo/:branch/reports/:reviewId" element={<ReportPage />} />
      <Route path="/branches/:repo/:branch/policy/:reviewId" element={<PolicyPage />} />
      <Route path="/policy/:reviewId" element={<PolicyPage />} />
      <Route path="/reports/:reviewId" element={<ReportPage />} />
      <Route path="*" element={<ReviewHistoryPage />} />
    </Routes>
  );
}
