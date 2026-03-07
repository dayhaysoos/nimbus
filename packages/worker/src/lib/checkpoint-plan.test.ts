import { strict as assert } from 'assert';
import {
  buildCheckpointExecutionPlan,
  detectPackageManager,
  normalizeProjectRoot,
  resolveProjectDir,
} from './checkpoint-plan.js';

export function runCheckpointPlanTests(): void {
  assert.equal(detectPackageManager(['package-lock.json']), 'npm');
  assert.equal(detectPackageManager(['bun.lockb']), 'bun');

  assert.throws(() => detectPackageManager(['pnpm-lock.yaml']), /pnpm lockfile/);
  assert.throws(() => detectPackageManager(['yarn.lock']), /yarn lockfile/);
  assert.throws(() => detectPackageManager([]), /No lockfile found/);

  assert.equal(resolveProjectDir('/root/source', '.'), '/root/source');
  assert.equal(resolveProjectDir('/root/source', 'apps/web'), '/root/source/apps/web');
  assert.equal(normalizeProjectRoot('./apps/web/'), 'apps/web');
  assert.throws(() => normalizeProjectRoot('../..'), /path traversal/);
  assert.throws(() => normalizeProjectRoot('/tmp'), /relative/);
  assert.throws(() => normalizeProjectRoot('///'), /relative/);

  {
    const plan = buildCheckpointExecutionPlan({
      packageManager: 'npm',
      scripts: { build: 'vite build', test: 'vitest', lint: 'eslint .' },
      runTestsIfPresent: true,
      runLintIfPresent: false,
    });

    assert.equal(plan.install, 'npm ci --include=dev --ignore-scripts --no-audit --no-fund');
    assert.equal(plan.build, 'npm run build');
    assert.equal(plan.test, 'npm run test');
    assert.equal(plan.lint, null);
  }

  {
    const plan = buildCheckpointExecutionPlan({
      packageManager: 'bun',
      scripts: { build: 'vite build' },
      runTestsIfPresent: true,
      runLintIfPresent: true,
    });

    assert.equal(plan.install, 'bun install --frozen-lockfile --ignore-scripts');
    assert.equal(plan.build, 'bun run build');
    assert.equal(plan.test, null);
    assert.equal(plan.lint, null);
  }
}
