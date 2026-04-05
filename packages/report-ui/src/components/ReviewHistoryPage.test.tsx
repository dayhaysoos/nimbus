import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

describe('ReviewHistoryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockEventSource.instances = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the current-branch empty state when no reviews are present', async () => {
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

    expect(await screen.findByText(/No reviews on this branch yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Review' })).toBeInTheDocument();
  });

  it('shows animated preflight progress copy while the new review panel is preparing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
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
          json: async () => new Promise(() => undefined),
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

    await waitFor(() => expect(screen.getByRole('button', { name: 'New Review' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'New Review' }));

    expect(await screen.findByText('Preparing review target…')).toBeInTheDocument();
    expect(screen.getByText('Resolving checkpoint')).toBeInTheDocument();
    expect(screen.getByText('Reading session context')).toBeInTheDocument();
    expect(screen.getByText('Loading related context')).toBeInTheDocument();
  });

  it('keeps current-branch history separate from browse-only branch history', async () => {
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
              id: 'rev_current',
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
              id: 'rev_other',
              workspaceId: 'ws_2',
              deploymentId: 'dep_2',
              repo: 'acme/web',
              branch: 'feature-x',
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

    expect(await screen.findByText(/Recent on this branch/i)).toBeInTheDocument();
    expect(screen.getByText(/Potentially unsafe mutation found in request handler/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume active review' })).toBeInTheDocument();
    expect(screen.getByText(/Browse other branches/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /feature-x/i })).toBeInTheDocument();
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

  it('streams start progress before navigating to the branch-scoped report route', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
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
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'New Review' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'New Review' }));
    expect(await screen.findByText('Ready for review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View technical details' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Start Review' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start Review' }));

    expect(await screen.findByText('Starting review…')).toBeInTheDocument();
    expect(MockEventSource.instances[0]?.url).toContain('/api/studio/new-review/start/events?');
    expect(MockEventSource.instances[0]?.url).toContain('policyMode=auto');

    MockEventSource.instances[0]?.emit('message', {
      type: 'stage',
      stage: 'workspace',
      state: 'active',
      label: 'Preparing workspace',
      detail: 'Creating an isolated workspace for the review target.',
    });
    expect(await screen.findByText('Preparing workspace')).toBeInTheDocument();

    MockEventSource.instances[0]?.emit('message', {
      type: 'completed',
      reviewId: 'rev_new',
      routePath: '/branches/acme%2Fweb/main/reports/rev_new',
      policyMode: 'auto',
      status: 'queued',
      detail: 'Review queued. Opening the live results route.',
    });

    expect(await screen.findByText('Branch main')).toBeInTheDocument();
  });
});
