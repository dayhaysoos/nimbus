import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockStudioDataSource } from './mockStudioDataSource';

describe('mockStudioDataSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('streams launch stages and completes into a session route', () => {
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'waiting',
    });
    const events: string[] = [];

    dataSource.startSession(
      {
        repo: 'dayhaysoos/nimbus',
        branch: 'codex/studio-launch-rebuild',
        lastCheckpoints: 1,
        policyMode: 'auto',
      },
      {
        onEvent(event) {
          if (event.type === 'stage') {
            events.push(event.stage);
            return;
          }
          if (event.type === 'completed') {
            events.push(event.routePath);
          }
        },
        onError(error) {
          throw error;
        },
      }
    );

    vi.advanceTimersByTime(2_000);

    expect(events).toContain('checkpoint');
    expect(events).toContain('/sessions/mock-waiting');
  });

  it('moves waiting sessions onto the shared completed-diff path after approval', async () => {
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'waiting',
    });
    const waiting = await dataSource.loadSession('mock-waiting');
    expect(waiting.capabilities.waitingOnHuman).toBe(true);

    await dataSource.approvePolicy({
      reviewId: waiting.activeReview?.id ?? 'missing',
      approvedPolicy: {
        goal: 'Keep the shared session route readable.',
        prohibitions: [],
        constraints: [],
      },
    });

    const approved = await dataSource.loadSession('mock-waiting');
    expect(approved.session.phase).toBe('completed');
    expect(approved.reviewedDiff.available).toBe(true);
  });
});
