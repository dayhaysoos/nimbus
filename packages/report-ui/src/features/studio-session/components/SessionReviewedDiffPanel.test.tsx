import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionReviewedDiffPanel } from './SessionReviewedDiffPanel';

const reviewedDiff = {
  visible: true,
  summaryItems: ['3 file(s) changed', 'Ready for isolated local adoption'],
  files: [
    { status: 'modified', path: 'packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx' },
    { status: 'modified', path: 'packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx' },
    { status: 'added', path: 'packages/report-ui/src/data/studio/StudioDataSource.tsx' },
  ],
  patch: `diff --git a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
index a1c3342..b26f912 100644
--- a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
+++ b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
@@ -181,6 +181,7 @@ export function StudioSessionScreen(): JSX.Element {
-  <h2>Reviewed diff</h2>
+  <h2>Reviewed diff</h2>
+  <p className="panel-subtle">Review the changed files before adopting.</p>
diff --git a/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx b/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
index c4411d2..ca7b9f0 100644
--- a/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
+++ b/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
@@ -83,7 +84,7 @@ export function StudioLaunchScreen(): JSX.Element {
-  Nimbus reviews the current commit for this branch.
+  Nimbus reviews the latest committed state on this branch.
diff --git a/packages/report-ui/src/data/studio/StudioDataSource.tsx b/packages/report-ui/src/data/studio/StudioDataSource.tsx
new file mode 100644
--- /dev/null
+++ b/packages/report-ui/src/data/studio/StudioDataSource.tsx
@@ -0,0 +1,4 @@
+export function createStudioDataSourceLabel(): string {
+  return 'Mock preview';
+}
`,
  emptyMessage: 'No diff available.',
};

describe('SessionReviewedDiffPanel', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders per-file sections with expand and collapse controls', async () => {
    const user = userEvent.setup();

    render(<SessionReviewedDiffPanel reviewedDiff={reviewedDiff} />);

    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx' })).toBeInTheDocument();
    expect(screen.getByText("return 'Mock preview';")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(screen.queryByText("return 'Mock preview';")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand packages/report-ui/src/data/studio/StudioDataSource.tsx' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(screen.getByText("return 'Mock preview';")).toBeInTheDocument();
  });

  it('expands and scrolls to a collapsed file when the jump chip is used', async () => {
    const user = userEvent.setup();

    render(<SessionReviewedDiffPanel reviewedDiff={reviewedDiff} />);

    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    await user.click(screen.getByRole('button', { name: 'Jump to packages/report-ui/src/data/studio/StudioDataSource.tsx' }));

    expect(screen.getByText("return 'Mock preview';")).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
