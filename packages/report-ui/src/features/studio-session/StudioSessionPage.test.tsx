import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { StudioDataSourceProvider } from '../../data/studio/StudioDataSource';
import { createMockStudioDataSource } from '../../data/studio/mockStudioDataSource';

describe('StudioSessionPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps policy approval inside the shared session route', async () => {
    const user = userEvent.setup();
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'waiting',
    });

    render(
      <StudioDataSourceProvider value={dataSource}>
        <MemoryRouter initialEntries={['/sessions/mock-waiting']}>
          <App />
        </MemoryRouter>
      </StudioDataSourceProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Review paused' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve policy' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Adopt locally' })).toBeInTheDocument();
  });

  it('shows adopt and merge-back on the same terminal session route', async () => {
    const user = userEvent.setup();
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'completed_diff',
    });

    render(
      <StudioDataSourceProvider value={dataSource}>
        <MemoryRouter initialEntries={['/sessions/mock-completed_diff']}>
          <App />
        </MemoryRouter>
      </StudioDataSourceProvider>
    );

    expect(await screen.findByRole('heading', { name: 'Review complete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adopt locally' }));

    await waitFor(() => {
      expect(screen.getByText('Local worktree ready')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Merge back into current branch' })).toBeInTheDocument();
  });
});
