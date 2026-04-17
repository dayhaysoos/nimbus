import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { StudioDataSourceProvider } from '../../data/studio/StudioDataSource';
import { createMockStudioDataSource } from '../../data/studio/mockStudioDataSource';
import { createStubStudioDataSource } from '../../test/studioDataSourceStub';

describe('StudioLaunchPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  it('starts a session from launch and routes into the shared session page', async () => {
    const user = userEvent.setup();
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'waiting',
    });

    render(
      <StudioDataSourceProvider value={dataSource}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </StudioDataSourceProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Review latest commit' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start review session' }));

    expect(await screen.findByRole('heading', { name: 'Review paused' }, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText('Approve the review policy')).toBeInTheDocument();
  });

  it('resumes the current session instead of showing a second launch path', async () => {
    const backingSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'completed_diff',
    });
    const aggregate = await backingSource.loadSession('session_existing');
    const dataSource = createStubStudioDataSource({
      async loadLaunchState() {
        return {
          context: {
            repo: 'dayhaysoos/nimbus',
            branch: 'codex/studio-launch-rebuild',
            detectedAt: '2026-04-16T00:00:00.000Z',
          },
          preflight: {
            repo: 'dayhaysoos/nimbus',
            branch: 'codex/studio-launch-rebuild',
            policyMode: 'auto',
            startability: 'intent_aware',
            contextMode: 'intent_aware',
            requestedLastCheckpoints: 1,
            effectiveLastCheckpoints: 1,
            lastCheckpoints: 1,
            checkpointSelectionMode: 'latest',
            checkpointId: 'checkpoint_existing',
            commitSha: '4f8c2be',
            includedCheckpoints: [],
            ready: true,
            capabilities: {
              canStart: true,
              canStartInBasicMode: true,
              canStartInIntentAwareMode: true,
              canReviewPolicy: true,
            },
            blockingIssues: [],
            warnings: [],
            checks: [],
          },
          currentSession: {
            ...aggregate.session,
            id: 'session_existing',
          },
        };
      },
      async loadSession() {
        return {
          ...aggregate,
          session: {
            ...aggregate.session,
            id: 'session_existing',
          },
        };
      },
    });

    render(
      <StudioDataSourceProvider value={dataSource}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </StudioDataSourceProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adopt locally' })).toBeInTheDocument();
  });
});
