import { ReportPage } from './ReportPage';

/**
 * Legacy alias route for older saved URLs.
 * Policy-stage and active-stage review states now share the single Review Run surface.
 */
export function PolicyPage(): JSX.Element {
  return <ReportPage />;
}
