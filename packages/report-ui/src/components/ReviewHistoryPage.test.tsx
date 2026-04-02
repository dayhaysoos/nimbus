import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('starts a review from the New Review panel', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/studio/context')) {
        return {
          ok: true,
          json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-03-01T00:00:00.000Z' }),
        };
      }
      if (url.includes('/api/studio/new-review/preflight')) {
        return {
          ok: true,
          json: async () => ({
            repo: 'acme/web',
            branch: 'main',
            policyMode: 'auto',
            checkpointId: 'cp_123',
            commitSha: 'abcdef123456',
            ready: true,
            checks: [
              { code: 'checkpoint', label: 'Checkpoint target', ok: true, detail: 'Resolved checkpoint cp_123.' },
              { code: 'entire_context', label: 'Entire context', ok: true, detail: 'Context is readable.' },
            ],
          }),
        };
      }
      if (url.includes('/api/studio/new-review/start')) {
        expect(init?.method).toBe('POST');
        return {
          ok: true,
          json: async () => ({
            reviewId: 'rev_new',
            routePath: '/reports/rev_new',
            policyMode: 'auto',
            status: 'queued',
          }),
        };
      }
      if (url.includes('/api/reviews/rev_new')) {
        return {
          ok: true,
          json: async () => ({
            review: {
              id: 'rev_new',
              workspaceId: 'ws_new',
              deploymentId: 'dep_new',
              target: {
                type: 'workspace_deployment',
                workspaceId: 'ws_new',
                deploymentId: 'dep_new',
              },
              mode: 'report_only',
              status: 'queued',
              idempotencyKey: 'idem_new',
              attemptCount: 1,
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
              startedAt: null,
              finishedAt: null,
              findings: [],
              evidence: [],
              provenance: {
                sessionIds: [],
                promptSummary: null,
              },
              markdownSummary: null,
            },
          }),
        };
      }
      if (url.includes('/api/reviews?limit=100')) {
        return {
          ok: true,
          json: async () => ({ reviews: [] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ reviews: [] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New Review' }));
    expect(await screen.findByRole('button', { name: 'Start Review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start Review' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/studio/new-review/start'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
