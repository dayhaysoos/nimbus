import assert from 'node:assert/strict';
import { hydrateReviewSandbox, runSandboxCommand, type SandboxClient } from '../../src/lib/review-analysis/sandbox.js';

export async function runReviewAnalysisSandboxTests(): Promise<void> {
  {
    const capturedTimeouts: Array<number | undefined> = [];
    const sandbox: SandboxClient = {
      async exec(_command, options) {
        capturedTimeouts.push(options?.timeout);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
    };

    await runSandboxCommand(sandbox, 'echo ok');
    assert.deepEqual(capturedTimeouts, [30_000]);
  }

  {
    const capturedTimeouts: Array<number | undefined> = [];
    const sandbox: SandboxClient = {
      async exec(_command, options) {
        capturedTimeouts.push(options?.timeout);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
    };

    const encoded = new TextEncoder().encode('tiny bundle');
    const bytes = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(bytes).set(encoded);
    await hydrateReviewSandbox(sandbox, bytes);

    assert.deepEqual(capturedTimeouts, [120_000, 30_000, 120_000, 120_000, 120_000]);
  }
}
