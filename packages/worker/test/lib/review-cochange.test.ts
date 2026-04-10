import { strict as assert } from 'assert';
import { rankAggregatedRelatedPaths } from '../../src/lib/review-runner/context-helpers.js';
import { selectCochangeMetadataPaths } from '../../src/lib/review-runner/cochange.js';

export function runReviewCochangeTests(): void {
  {
    assert.deepEqual(
      selectCochangeMetadataPaths([
        '70/fe2db7f306/metadata.json',
        '70/fe2db7f306/7/metadata.json',
        '70/fe2db7f306/6/metadata.json',
      ]),
      ['70/fe2db7f306/7/metadata.json', '70/fe2db7f306/6/metadata.json']
    );
  }

  {
    const entriesByChangedPath = new Map<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>([
      [
        'src/a.ts',
        [
          { path: 'src/context.ts', frequency: 3, sessionIds: ['ses_1', 'ses_2', 'ses_3'] },
          { path: 'src/noisy.ts', frequency: 3, sessionIds: ['ses_1', 'ses_2', 'ses_3'] },
        ],
      ],
      [
        'src/b.ts',
        [
          { path: 'src/context.ts', frequency: 3, sessionIds: ['ses_1', 'ses_2', 'ses_3'] },
          { path: 'src/noisy.ts', frequency: 1, sessionIds: ['ses_1'] },
        ],
      ],
    ]);

    const ranked = rankAggregatedRelatedPaths(['src/a.ts', 'src/b.ts'], entriesByChangedPath, 10);
    assert.deepEqual(ranked, [
      { path: 'src/context.ts', frequency: 3, sessionIds: ['ses_1', 'ses_2', 'ses_3'] },
      { path: 'src/noisy.ts', frequency: 3, sessionIds: ['ses_1', 'ses_2', 'ses_3'] },
    ]);
  }

  {
    const entriesByChangedPath = new Map<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>([
      [
        'src/a.ts',
        [
          { path: 'src/shared.ts', frequency: 2, sessionIds: [] },
        ],
      ],
    ]);

    const ranked = rankAggregatedRelatedPaths(['src/a.ts'], entriesByChangedPath, 10);
    assert.deepEqual(ranked, [{ path: 'src/shared.ts', frequency: 2, sessionIds: [] }]);
  }
}
