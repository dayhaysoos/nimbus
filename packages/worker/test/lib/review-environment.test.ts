import { strict as assert } from 'assert';
import { captureWorkspaceEnvironmentSnapshot } from '../../src/lib/review-runner/environment.js';
import { setReviewAnalysisSandboxResolverForTests } from '../../src/lib/review-analysis/sandbox.js';

export async function runReviewEnvironmentTests(): Promise<void> {
  let sourceBundleReadCount = 0;
  const sandbox = {
    async exec(command: string) {
      if (command.includes('git rev-parse --verify HEAD')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.includes('git read-tree HEAD') && command.includes('git diff --cached -M HEAD')) {
        return {
          stdout: 'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-a\n+b\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async writeFile() {
      return undefined;
    },
  };

  setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
  try {
    const snapshot = await captureWorkspaceEnvironmentSnapshot(
      {
        SOURCE_BUNDLES: {
          async get() {
            sourceBundleReadCount += 1;
            throw new Error('source bundle should not be read when git HEAD exists');
          },
        },
      } as never,
      {
        id: 'ws_environment',
        status: 'ready',
        sandboxId: 'workspace-ws_environment',
        baselineReady: false,
        sourceBundleKey: 'workspaces/ws_environment/source/bundle.tar.gz',
        sourceBundleSha256: 'f'.repeat(64),
      }
    );

    assert.equal(sourceBundleReadCount, 0);
    assert.equal(snapshot.changedPaths.length, 1);
    assert.equal(snapshot.changedPaths[0], 'src/index.ts');
  } finally {
    setReviewAnalysisSandboxResolverForTests(null);
  }
}
