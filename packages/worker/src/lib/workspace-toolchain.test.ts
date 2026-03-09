import { strict as assert } from 'assert';
import {
  applyRequestedToolchainOverride,
  deriveWorkspaceToolchainProfile,
  parsePackageManagerSpec,
} from './workspace-toolchain.js';

export function runWorkspaceToolchainTests(): void {
  assert.deepEqual(parsePackageManagerSpec('pnpm@9.12.1'), {
    manager: 'pnpm',
    version: '9.12.1',
  });
  assert.deepEqual(parsePackageManagerSpec('yarn'), {
    manager: 'yarn',
    version: null,
  });
  assert.equal(parsePackageManagerSpec('bun@1.1.0'), null);

  {
    const profile = deriveWorkspaceToolchainProfile({
      packageManager: 'pnpm@9.15.0',
      scripts: { test: 'npm run test' },
      lockfiles: {
        pnpm: 'abc123',
        yarn: null,
        npm: null,
      },
      projectRoot: './apps/web/',
    });
    assert.equal(profile.manager, 'pnpm');
    assert.equal(profile.version, '9.15.0');
    assert.equal(profile.detectedFrom, 'packageManager');
    assert.equal(profile.projectRoot, 'apps/web');
    assert.equal(profile.lockfile?.name, 'pnpm-lock.yaml');
  }

  {
    const profile = deriveWorkspaceToolchainProfile({
      packageManager: null,
      scripts: { build: 'npm run build' },
      lockfiles: {
        pnpm: null,
        yarn: 'lock-yarn',
        npm: null,
      },
      projectRoot: '.',
    });
    assert.equal(profile.manager, 'yarn');
    assert.equal(profile.detectedFrom, 'lockfile');
    assert.equal(profile.lockfile?.name, 'yarn.lock');
  }

  {
    const profile = deriveWorkspaceToolchainProfile({
      packageManager: null,
      scripts: { test: 'pnpm test' },
      lockfiles: {
        pnpm: null,
        yarn: null,
        npm: null,
      },
      projectRoot: '.',
    });
    assert.equal(profile.manager, 'pnpm');
    assert.equal(profile.detectedFrom, 'scripts');
  }

  {
    const profile = deriveWorkspaceToolchainProfile({
      packageManager: null,
      scripts: { lint: 'eslint .' },
      lockfiles: {
        pnpm: null,
        yarn: null,
        npm: null,
      },
      projectRoot: '.',
    });
    assert.equal(profile.manager, 'npm');
    assert.equal(profile.detectedFrom, 'fallback');
  }

  assert.throws(
    () =>
      deriveWorkspaceToolchainProfile({
        packageManager: 'npm@10.8.2',
        scripts: {},
        lockfiles: {
          pnpm: null,
          yarn: null,
          npm: null,
        },
        projectRoot: '../outside',
      }),
    /invalid path traversal segments/
  );

  {
    const overridden = applyRequestedToolchainOverride(
      {
        manager: 'pnpm',
        version: '9.15.0',
        detectedFrom: 'packageManager',
        projectRoot: '.',
        lockfile: { name: 'pnpm-lock.yaml', sha256: 'abc' },
      },
      { manager: 'npm', version: '10.8.2' }
    );
    assert.equal(overridden.manager, 'npm');
    assert.equal(overridden.version, '10.8.2');
    assert.equal(overridden.detectedFrom, 'request');
    assert.equal(overridden.lockfile, null);
  }
}
