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
    const sandbox: SandboxClient = {
      async exec() {
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
  }
}
