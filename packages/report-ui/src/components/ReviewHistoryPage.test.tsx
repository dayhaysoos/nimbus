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
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/studio/context')) {
        return {
          ok: true,
          json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-03-01T00:00:00.000Z' }),
        };
      }
      return {
        ok: true,
        json: async () => ({ reviews: [] }),
      };
    }));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText(/No other branch review history yet\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Review' })).toBeInTheDocument();
  });

  it('renders branch list links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/studio/context')) {
        return {
          ok: true,
          json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-03-01T00:00:00.000Z' }),
        };
      }
      return {
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
      };
    }));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    const resume = await screen.findByRole('button', { name: 'Resume active review' });
    expect(resume).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.some((link) => link.getAttribute('href')?.includes('/branches/acme%2Fapi/main'))).toBe(true);
  });

  it('does not resume from a different branch when current context has no reviews', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/studio/context')) {
        return {
          ok: true,
          json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-03-01T00:00:00.000Z' }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          reviews: [
            {
              id: 'rev_other_branch',
              workspaceId: 'ws_3',
              deploymentId: 'dep_3',
              repo: 'acme/web',
              branch: 'feature-x',
              status: 'running',
              createdAt: '2026-03-01T00:00:04.000Z',
              updatedAt: '2026-03-01T00:00:04.000Z',
              startedAt: '2026-03-01T00:00:03.000Z',
              finishedAt: null,
              findingCount: 1,
              riskLevel: 'medium',
              recommendation: 'comment',
              summaryText: 'Review in progress.',
            },
          ],
        }),
      };
    }));

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume active review' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /feature-x/i })).toBeInTheDocument();
  });
});
