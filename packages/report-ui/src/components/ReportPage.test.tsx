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
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText(/waiting for an available worker slot/i)).toBeInTheDocument();
    expect(screen.getByText('Raw JSON')).toBeInTheDocument();
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

    await screen.findByText('Running');
    expect(screen.getByText(/analysis is in progress/i)).toBeInTheDocument();
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
    expect(screen.getByText('One high-severity issue requires a null guard before property access.')).toBeInTheDocument();
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

  it('copies finding fix prompt and shows toast', async () => {
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
    const [copyFixPromptButton] = screen.getAllByRole('button', { name: 'Copy fix prompt' });
    await user.click(copyFixPromptButton);

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

    await screen.findByText('Co-change context');
    expect(screen.getByText(/baseline context only/i)).toBeInTheDocument();
    expect(screen.getByText(/REVIEW_CONTEXT_GITHUB_TOKEN/)).toBeInTheDocument();
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
