import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportPage } from './ReportPage';

const mockReview = {
  id: 'review_123',
  workspaceId: 'ws_123',
  deploymentId: 'dep_123',
  target: {
    type: 'workspace_deployment',
    workspaceId: 'ws_123',
    deploymentId: 'dep_123',
  },
  mode: 'report_only',
  status: 'queued',
  idempotencyKey: 'idem_123',
  attemptCount: 1,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  summary: {
    recommendation: 'comment',
    riskLevel: 'medium',
    findingCounts: {
      info: 0,
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
    },
  },
  findings: [
    {
      severity: 'high',
      category: 'logic',
      passType: 'single',
      description: 'A property is used without a null check.',
      locations: [{ filePath: 'src/service.ts', startLine: 18, endLine: 18 }],
      suggestedFix: 'Add null guard before access.',
    },
  ],
  evidence: [
    {
      id: 'ev_1',
      type: 'test',
      label: 'failure trace',
      status: 'failed',
    },
  ],
  provenance: {
    sessionIds: ['ses_1'],
    promptSummary: 'Review generated in report_only mode for deployment dep_123.',
    outputSchemaVersion: 'v2',
    passArchitecture: 'single',
  },
  summaryText: 'One high-severity issue requires a null guard before property access.',
  furtherPassesLowYield: false,
  markdownSummary: '# Review\n\n- one finding',
};

describe('ReportPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders queued review state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ review: mockReview }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Review review_123');
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/waiting for an available worker slot/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Live review activity')).toBeInTheDocument();
    expect(screen.getByText('Waiting for events...')).toBeInTheDocument();
    expect(screen.getByText('Raw JSON')).toBeInTheDocument();
  });

  it('renders branch-scoped breadcrumbs when opened from Studio Home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ review: mockReview }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/branches/acme%2Fweb/main/reports/review_123']}>
        <Routes>
          <Route path="/branches/:repo/:branch/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Studio Home')).toBeInTheDocument();
    expect(screen.getByText('Branch main')).toBeInTheDocument();
  });

  it('renders running review state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'running',
            startedAt: '2026-03-01T00:00:05.000Z',
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect((await screen.findAllByText('Running')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/analysis is in progress/i).length).toBeGreaterThan(0);
  });

  it('renders policy_pending as an in-route pre-run state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'policy_pending',
            findings: [],
            summary: undefined,
            summaryText: undefined,
            markdownSummary: null,
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Preparing policy draft');
    expect(screen.getByText(/This route will stay open/i)).toBeInTheDocument();
    expect(screen.getByText('Review review_123')).toBeInTheDocument();
  });

  it('renders policy_ready editor and approves policy without route swap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'policy_ready',
            findings: [],
            summary: undefined,
            summaryText: undefined,
            markdownSummary: null,
            derivedPolicy: {
              goal: 'Reduce risk quickly',
              prohibitions: ['Do not alter public API behavior'],
              constraints: ['Prefer small isolated changes'],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'policy_approved',
            findings: [],
            summary: undefined,
            summaryText: undefined,
            markdownSummary: null,
            approvedPolicy: {
              goal: 'Updated goal',
              prohibitions: ['Do not alter public API behavior'],
              constraints: ['Prefer small isolated changes'],
            },
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'policy_approved',
            findings: [],
            summary: undefined,
            summaryText: undefined,
            markdownSummary: null,
            approvedPolicy: {
              goal: 'Updated goal',
              prohibitions: ['Do not alter public API behavior'],
              constraints: ['Prefer small isolated changes'],
            },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Policy review required');
    const user = userEvent.setup();
    const goalInput = screen.getByPlaceholderText('Reduce production risk while keeping fixes minimal.');
    await user.clear(goalInput);
    await user.type(goalInput, 'Updated goal');
    await user.click(screen.getByRole('button', { name: 'Approve policy' }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/reviews/review_123/policy/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          approvedPolicy: {
            goal: 'Updated goal',
            prohibitions: ['Do not alter public API behavior'],
            constraints: ['Prefer small isolated changes'],
          },
        }),
      })
    );
    expect(await screen.findByText('Waiting for queue handoff')).toBeInTheDocument();
  });

  it('renders policy_approved as an in-route handoff state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'policy_approved',
            findings: [],
            summary: undefined,
            summaryText: undefined,
            markdownSummary: null,
            approvedPolicy: {
              goal: 'Maintain stability',
              prohibitions: ['No API changes'],
              constraints: ['Prefer localized edits'],
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Waiting for queue handoff');
    expect(screen.getByText(/stay on this route/i)).toBeInTheDocument();
    expect(screen.getByText('Review review_123')).toBeInTheDocument();
  });

  it('allows failing a running review from the report page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ review: { ...mockReview, status: 'running' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          action: 'requeued',
          review: {
            ...mockReview,
            status: 'failed',
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'queued',
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Live review activity');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fail review' }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/reviews/review_123/fail',
      expect.objectContaining({ method: 'POST' })
    );
    expect(await screen.findByText('Review marked failed')).toBeInTheDocument();
  });

  it('shows the returned status when a fail request loses a race', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ review: { ...mockReview, status: 'running' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          action: 'failed',
          review: {
            ...mockReview,
            status: 'succeeded',
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'succeeded',
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Live review activity');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fail review' }));

    expect(await screen.findByText('Review is already succeeded')).toBeInTheDocument();
  });

  it('renders succeeded review strict v2 output details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'succeeded',
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Succeeded');
    expect(screen.getByText('Model output')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('single')).toBeInTheDocument();
    expect(screen.getByText(/^no$/)).toBeInTheDocument();
    expect(screen.getAllByText('One high-severity issue requires a null guard before property access.').length).toBeGreaterThan(0);
  });

  it('keeps zero-finding review output compact until review details are expanded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'succeeded',
            summary: {
              recommendation: 'approve',
              riskLevel: 'low',
              findingCounts: {
                info: 0,
                critical: 0,
                high: 0,
                medium: 0,
                low: 0,
              },
            },
            findings: [],
            summaryText:
              'Adds branch-scoped routing for review studio UI. Changes build route paths to include branch context when repo and branch are available.',
            intent: {
              goal: 'Complete a task by committing a single missing file.',
              constraints: ['Non-mutating review only.'],
              decisions: ['Review mode: report_only.'],
            },
            evidence: [
              {
                id: 'ev_8',
                type: 'deployment_provider_created',
                label: 'deployment provider created',
                status: 'passed',
              },
              {
                id: 'ev_review_agent',
                type: 'analysis_agent',
                label: 'AI review analysis via cloudflare_agents_sdk',
                status: 'info',
              },
            ],
            provenance: {
              ...mockReview.provenance,
              sessionIds: ['019d5552-9f6b-7d43-9216-7a9c13d1c4f2'],
              promptSummary: 'Review with Entire checkpoint intent context (b14beb14f08b).',
              reviewContextStats: {
                totalFilesIncluded: 22,
                totalBytesIncluded: 234776,
                estimatedTokens: 71727,
                tokenBudget: null,
              },
              reviewedFiles: {
                changed: ['packages/report-ui/src/components/ReportPage.tsx'],
                related: ['packages/report-ui/src/lib/review.ts'],
                conventions: ['package.json'],
              },
              coChange: {
                coChangeSkipped: false,
                coChangeSkipReason: null,
                coChangeAvailable: true,
                relatedFileCount: 8,
              },
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Successful review');
    expect(screen.getByText('Successful review')).toBeInTheDocument();
    expect(screen.getAllByText('Files reviewed').length).toBeGreaterThan(0);
    expect(screen.getByText('Sessions used')).toBeInTheDocument();
    expect(screen.getByText('Related files')).toBeInTheDocument();
    expect(screen.getByText('No actionable findings identified')).toBeInTheDocument();
    expect(screen.getByText('Review summary')).not.toBeVisible();
    expect(screen.getByText('Intent')).not.toBeVisible();
    expect(screen.getByText('Review scope')).not.toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText('Review details'));

    expect(await screen.findByText('Review summary')).toBeInTheDocument();
    expect(screen.getAllByText(/Adds branch-scoped routing for review studio UI/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Intent')).toBeInTheDocument();
    expect(screen.getByText('Complete a task by committing a single missing file.')).toBeInTheDocument();
    expect(screen.getByText('Review scope')).toBeInTheDocument();
    expect(screen.getAllByText(/Review with Entire checkpoint intent context/).length).toBeGreaterThan(0);
    expect(screen.getByText(/22 files/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /view files/i }));

    expect(screen.getByRole('dialog', { name: 'Reviewed files' })).toBeInTheDocument();
    expect(screen.getByText('Changed in this review')).toBeInTheDocument();
    expect(screen.getAllByText('Related files').length).toBeGreaterThan(0);
    expect(screen.getByText('Convention and config files')).toBeInTheDocument();
    expect(screen.getByText('packages/report-ui/src/components/ReportPage.tsx')).toBeInTheDocument();
    expect(screen.getByText('packages/report-ui/src/lib/review.ts')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('renders failed review with actionable guidance for provider/validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'failed',
            error: {
              code: 'review_execution_failed',
              message: 'Review analysis provider request timed out after 120 seconds.',
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Failure guidance');
    expect(screen.getByText(/analysis provider failed/i)).toBeInTheDocument();
    expect(screen.getByText(/strictly public fetch/i)).toBeInTheDocument();
  });

  it('copies a finding and shows toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ review: mockReview }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('A property is used without a null check.');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('disables markdown actions when markdown is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            markdownSummary: null,
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Review review_123');
    expect(screen.getByRole('button', { name: 'Copy full markdown' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download markdown' })).toBeDisabled();
  });

  it('shows co-change advisory when lookup is skipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            provenance: {
              coChange: {
                coChangeSkipped: true,
                coChangeSkipReason: 'missing_github_token',
                coChangeAvailable: false,
                relatedFileCount: 0,
              },
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect((await screen.findAllByText(/baseline context only/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/REVIEW_CONTEXT_GITHUB_TOKEN/).length).toBeGreaterThan(0);
  });

  it('shows context fallback provenance details when branch fallback is used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'succeeded',
            provenance: {
              ...mockReview.provenance,
              contextResolution: {
                contextResolution: 'branch_fallback',
                originalCheckpointId: 'cp_original',
                resolvedCheckpointId: 'cp_resolved',
                resolvedCommitSha: 'abcdef1234567890',
                resolvedCommitMessage: 'fix: restore checkpoint context',
              },
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Context fallback used');
    expect(screen.getByText(/branch fallback/i)).toBeInTheDocument();
    expect(screen.getByText('cp_original')).toBeInTheDocument();
    expect(screen.getByText('cp_resolved')).toBeInTheDocument();
  });

  it('shows large-diff provenance advisory when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          review: {
            ...mockReview,
            status: 'succeeded',
            provenance: {
              ...mockReview.provenance,
              advisories: ['Large diff detected (42 files). Consider smaller, focused commits for higher quality reviews.'],
            },
          },
        }),
      })
    );

    render(
      <MemoryRouter initialEntries={['/reports/review_123']}>
        <Routes>
          <Route path="/reports/:reviewId" element={<ReportPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('Advisories');
    expect(
      screen.getByText('Large diff detected (42 files). Consider smaller, focused commits for higher quality reviews.', {
        selector: 'li',
      })
    ).toBeInTheDocument();
  });
});
