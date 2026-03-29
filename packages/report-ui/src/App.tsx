import { Route, Routes } from 'react-router-dom';
import { ReportPage } from './components/ReportPage';
import { PolicyPage } from './components/PolicyPage';
import { ReviewHistoryPage } from './components/ReviewHistoryPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<ReviewHistoryPage />} />
      <Route path="/policy/:reviewId" element={<PolicyPage />} />
      <Route path="/reports/:reviewId" element={<ReportPage />} />
      <Route path="*" element={<ReviewHistoryPage />} />
    </Routes>
  );
}
