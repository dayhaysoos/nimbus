import { strict as assert } from 'assert';
import {
  getAutoEnvDiscoveryDirectories,
  isValidProjectRootPath,
  resolveEnvFileLoadOrder,
} from './checkpoint.js';

export function runCheckpointCommandTests(): void {
  {
    const directories = getAutoEnvDiscoveryDirectories('/repo', 'apps/web');
    assert.deepEqual(directories, ['/repo', '/repo/apps/web']);
  }

  {
    const directories = getAutoEnvDiscoveryDirectories('/repo', '.');
    assert.deepEqual(directories, ['/repo']);
  }

  {
    const ordered = resolveEnvFileLoadOrder({
      autoDiscoveredFiles: [
        '/repo/.env.local',
        '/repo/apps/web/.env',
      ],
      explicitFiles: [
        '/repo/custom/.env.override',
        '/repo/custom/.env.second',
      ],
    });

    assert.deepEqual(ordered, [
      '/repo/.env.local',
      '/repo/apps/web/.env',
      '/repo/custom/.env.override',
      '/repo/custom/.env.second',
    ]);
  }

  {
    const ordered = resolveEnvFileLoadOrder({
      autoDiscoveredFiles: ['/repo/.env.local', '/repo/custom/.env.override'],
      explicitFiles: ['/repo/custom/.env.override'],
    });

    assert.deepEqual(ordered, ['/repo/.env.local', '/repo/custom/.env.override']);
  }

  {
    const treePaths = ['package.json', 'packages/cli/package.json', 'packages/cli/src/index.ts'];

    assert.equal(isValidProjectRootPath(treePaths, '.'), true);
    assert.equal(isValidProjectRootPath(treePaths, 'packages/cli'), true);
    assert.equal(isValidProjectRootPath(treePaths, 'package.json'), false);
    assert.equal(isValidProjectRootPath(treePaths, 'packages/cli/package.json'), false);
  }
}
