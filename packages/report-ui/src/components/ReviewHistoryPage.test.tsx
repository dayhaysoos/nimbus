import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

describe('ReviewHistoryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders an empty state when no reviews are present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ reviews: [] }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText(/No reviews yet\./)).toBeInTheDocument();
  });

  it('renders review history links with newest first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          reviews: [
            {
              id: 'rev_newer',
              workspaceId: 'ws_1',
              deploymentId: 'dep_1',
              repo: 'acme/web',
              branch: 'main',
              status: 'running',
              createdAt: '2026-03-01T00:00:04.000Z',
              updatedAt: '2026-03-01T00:00:04.000Z',
              startedAt: '2026-03-01T00:00:03.000Z',
              finishedAt: null,
              findingCount: 2,
              riskLevel: 'high',
              recommendation: 'request_changes',
              summaryText: 'Potentially unsafe mutation found in request handler.',
            },
            {
              id: 'rev_older',
              workspaceId: 'ws_2',
              deploymentId: 'dep_2',
              repo: 'acme/api',
              branch: 'main',
              status: 'succeeded',
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:01.000Z',
              startedAt: '2026-03-01T00:00:00.500Z',
              finishedAt: '2026-03-01T00:00:01.000Z',
              findingCount: 0,
              riskLevel: 'low',
              recommendation: 'approve',
              summaryText: 'No issues found.',
            },
          ],
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const links = await screen.findAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/branches/acme%2Fweb/main');
    expect(links[1]).toHaveAttribute('href', '/branches/acme%2Fapi/main');
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});
