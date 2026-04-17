import { describe, expect, it } from 'vitest';
import { createMockStudioDataSource } from '../../data/studio/mockStudioDataSource';
import {
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioSessionAggregateResponse,
} from '../../lib/review';

describe('studio parsers', () => {
  it('parses studio context response', () => {
    const payload = parseStudioContextResponse({
      repo: 'acme/web',
      branch: 'main',
      detectedAt: '2026-03-01T00:00:00.000Z',
    });

    expect(payload.repo).toBe('acme/web');
    expect(payload.branch).toBe('main');
  });

  it('parses new review preflight response', () => {
    const payload = parseStudioNewReviewPreflightResponse({
      repo: 'acme/web',
      branch: 'main',
      policyMode: 'auto',
      startability: 'intent_aware',
      contextMode: 'intent_aware',
      requestedLastCheckpoints: 1,
      effectiveLastCheckpoints: 1,
      lastCheckpoints: 1,
      checkpointSelectionMode: 'latest',
      checkpointId: 'cp_123',
      commitSha: 'abcdef1234567890',
      includedCheckpoints: [
        {
          checkpointId: 'cp_123',
          commitSha: 'abcdef1234567890',
          commitSubject: 'feat: latest checkpoint',
        },
      ],
      ready: true,
      capabilities: {
        canStart: true,
        canStartInBasicMode: true,
        canStartInIntentAwareMode: true,
        canReviewPolicy: true,
      },
      blockingIssues: [],
      warnings: [],
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint',
          ok: true,
          detail: 'Resolved checkpoint cp_123.',
        },
      ],
    });

    expect(payload.startability).toBe('intent_aware');
    expect(payload.checkpointId).toBe('cp_123');
    expect(payload.capabilities.canStart).toBe(true);
  });

  it('parses session aggregate responses for terminal studio sessions', async () => {
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'completed_diff',
    });

    const aggregate = await dataSource.loadSession('mock-completed_diff');
    const parsed = parseStudioSessionAggregateResponse(aggregate);

    expect(parsed.session.phase).toBe('completed');
    expect(parsed.reviewedDiff.available).toBe(true);
    expect(parsed.adopt.available).toBe(true);
  });
});
