import { describe, expect, it } from 'vitest';
import { createMockStudioDataSource } from '../../data/studio/mockStudioDataSource';
import { buildSessionViewModel } from './sessionViewModel';

describe('buildSessionViewModel', () => {
  it('marks waiting sessions as editable human checkpoints', async () => {
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'waiting',
    });

    const aggregate = await dataSource.loadSession('mock-waiting');
    const viewModel = buildSessionViewModel({
      aggregate,
      activity: aggregate.activity,
      events: [],
      localDiff: null,
      adoptResult: null,
    });

    expect(viewModel.isWaitingOnHuman).toBe(true);
    expect(viewModel.policy.editable).toBe(true);
    expect(viewModel.stageTitle).toBe('Review paused');
  });

  it('surfaces adopt and reviewed diff state for completed sessions', async () => {
    const dataSource = createMockStudioDataSource({
      VITE_STUDIO_MOCK: '1',
      VITE_STUDIO_MOCK_SESSION_STATE: 'completed_diff',
    });

    const aggregate = await dataSource.loadSession('mock-completed_diff');
    const viewModel = buildSessionViewModel({
      aggregate,
      activity: aggregate.activity,
      events: [],
      localDiff: null,
      adoptResult: null,
    });

    expect(viewModel.isTerminal).toBe(true);
    expect(viewModel.reviewedDiff.visible).toBe(true);
    expect(viewModel.adopt.canAdopt).toBe(true);
    expect(viewModel.result?.recommendation).toBe('Adopt locally');
  });
});
