import { Route, Routes } from 'react-router-dom';
import { ReportPage } from './components/ReportPage';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/reports/:reviewId" element={<ReportPage />} />
      <Route
        path="*"
        element={
          <main className="page">
            <section className="card status-card">
              <h1>Nimbus Report Viewer</h1>
              <p>Open a report URL in the format /reports/&lt;reviewId&gt;.</p>
            </section>
          </main>
        }
      />
    </Routes>
  );
}
