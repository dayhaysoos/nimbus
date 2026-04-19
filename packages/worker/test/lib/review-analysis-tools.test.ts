import assert from 'node:assert/strict';
import { executeReviewTool, validateReviewAgentAction } from '../../src/lib/review-analysis/tools.js';
import type { ReviewCommandPolicy } from '../../src/lib/review-analysis/tools.js';
import type { SandboxClient } from '../../src/lib/review-analysis/sandbox.js';

export async function runReviewAnalysisToolsTests(): Promise<void> {
  {
    const action = validateReviewAgentAction({
      type: 'final',
      finalOutput: {
        findings: [],
        summary: 'No actionable findings.',
        furtherPassesLowYield: true,
      },
      summary: null,
    });
    assert.equal(action.type, 'complete');
  }

  {
    let capturedTimeout: number | undefined;
    const sandbox: SandboxClient = {
      async exec(_command, options) {
        capturedTimeout = options?.timeout;
        return { stdout: '{}', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
    };

    const policy: ReviewCommandPolicy = {
      commandAllow: [],
      commandDeny: [],
      maxCommandTimeoutMs: 30_000,
      maxOutputBytes: 96_000,
      rootPath: '/workspace',
    };

    const output = await executeReviewTool(
      sandbox,
      { type: 'tool', tool: 'search_code', args: { query: '   ', path: '.', maxResults: 10 } },
      policy,
      48_000
    );
    const result = output.result as Record<string, unknown>;
    assert.equal(result.error, 'search_code.query is required');
    assert.equal(capturedTimeout, undefined);
  }

  {
    const action = validateReviewAgentAction({
      type: 'tool',
      tool: 'read_batch',
      args: {
        paths: ['a.ts', 'b.ts'],
        maxBytes: 1024,
        path: null,
        query: null,
        symbol: null,
        maxResults: null,
        maxBytesPerFile: null,
        caseSensitive: null,
      },
      summary: null,
      finalOutput: null,
    });
    assert.equal(action.type, 'tool');
    assert.equal(action.tool, 'read_batch');
  }

  {
    const capturedTimeouts: Array<number | undefined> = [];
    const sandbox: SandboxClient = {
      async exec(_command, options) {
        capturedTimeouts.push(options?.timeout);
        return { stdout: '{"entries":[]}', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return undefined;
      },
    };

    const policy: ReviewCommandPolicy = {
      commandAllow: [],
      commandDeny: [],
      maxCommandTimeoutMs: 45_000,
      maxOutputBytes: 96_000,
      rootPath: '/workspace',
    };

    await executeReviewTool(
      sandbox,
      { type: 'tool', tool: 'list_files', args: { path: '.' } },
      policy,
      48_000
    );

    assert.deepEqual(capturedTimeouts, [45_000]);
  }
}
