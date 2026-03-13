import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportPage } from './ReportPage';

const mockReview = {
  id: 'review_123',
  status: 'queued',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  summary: {
    recommendation: 'comment',
    riskLevel: 'medium',
    findingCounts: {
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
    },
  },
  findings: [
    {
      id: 'finding_1',
      severity: 'high',
      confidence: 'medium',
      title: 'Null check missing',
      description: 'A property is used without a null check.',
      conditions: null,
      locations: [{ path: 'src/service.ts', line: 18 }],
      suggestedFix: null,
      evidenceRefs: ['ev_1'],
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
    expect(screen.getByText('Review status')).toBeInTheDocument();
    expect(screen.getByText('Review is queued and has not started yet.')).toBeInTheDocument();
    expect(screen.getByText('Raw JSON')).toBeInTheDocument();
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

    await screen.findByText('Null check missing');
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
});
