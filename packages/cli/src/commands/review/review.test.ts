import { strict as assert } from 'assert';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReviewCommand } from './create.js';
import { reviewEventsCommand } from './events.js';
import { showReviewCommand } from './show.js';
import { exportReviewCommand } from './export.js';

function createReviewResponseBody() {
  return {
    review: {
      id: 'rev_abcd1234',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      target: {
        type: 'workspace_deployment',
        workspaceId: 'ws_abc12345',
        deploymentId: 'dep_abcd1234',
      },
      mode: 'report_only',
      status: 'succeeded',
      idempotencyKey: 'idem-review',
      attemptCount: 1,
      startedAt: '2026-03-11T00:00:00.000Z',
      finishedAt: '2026-03-11T00:01:00.000Z',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:01:00.000Z',
      summary: {
        riskLevel: 'low',
        findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        recommendation: 'approve',
      },
      findings: [],
      intent: {
        goal: 'Assess deployment readiness.',
        constraints: ['Non-mutating review only.'],
        decisions: ['Deployment provider: simulated.'],
      },
      evidence: [
        {
          id: 'ev_deployed_url',
          type: 'deploy_probe',
          label: 'Deployed URL present',
          status: 'passed',
          metadata: { url: 'https://example.com' },
        },
      ],
      provenance: {
        sessionIds: [],
        promptSummary: 'Review generated for deployment dep_abcd1234.',
        transcriptUrl: null,
      },
      markdownSummary: '## Review Summary\n\n- Recommendation: approve\n- Risk level: low\n- Findings: 0',
    },
  };
}

export async function runReviewCommandTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;
  process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

  try {
    {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            reviewId: 'rev_abcd1234',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_abcd1234/events',
            resultUrl: '/api/reviews/rev_abcd1234',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      await createReviewCommand('ws_abc12345', 'dep_abcd1234', {
        idempotencyKey: 'idem-review-1',
        severityThreshold: 'medium',
        maxFindings: 12,
        includeProvenance: false,
        includeValidationEvidence: false,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.endsWith('/api/reviews'), true);
      assert.equal((requests[0].init?.headers as Record<string, string>)['Idempotency-Key'], 'idem-review-1');
      const requestBody = JSON.parse(String(requests[0].init?.body ?? '{}')) as {
        policy?: {
          severityThreshold?: string;
          maxFindings?: number;
          includeProvenance?: boolean;
          includeValidationEvidence?: boolean;
        };
      };
      assert.equal(requestBody.policy?.severityThreshold, 'medium');
      assert.equal(requestBody.policy?.maxFindings, 12);
      assert.equal(requestBody.policy?.includeProvenance, false);
      assert.equal(requestBody.policy?.includeValidationEvidence, false);
    }

    {
      let fetchCount = 0;
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCount += 1;
        return new Response(JSON.stringify(createReviewResponseBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await showReviewCommand('rev_abcd1234');
      assert.equal(fetchCount, 1);
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      try {
        globalThis.fetch = (async (): Promise<Response> => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  ['id: 1', 'data: {"type":"review_created","seq":1,"createdAt":"2026-03-11T00:00:00.000Z"}', '', ''].join('\n')
                )
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
              controller.enqueue(
                encoder.encode(
                  ['data: {"type":"terminal","status":"succeeded"}', 'data: {"type":"snapshot","status":"succeeded"}', '', ''].join('\n')
                )
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }) as typeof fetch;

        await reviewEventsCommand('rev_abcd1234');
        assert.equal(lines.some((line) => line.includes('[1] review_created')), true);
        assert.equal(lines.some((line) => line.includes('[terminal] status=succeeded')), true);
        assert.equal(lines.some((line) => line.includes('[snapshot] status=succeeded')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(JSON.stringify(createReviewResponseBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const dir = await mkdtemp(join(tmpdir(), 'nimbus-review-'));
      try {
        const markdownPath = join(dir, 'review.md');
        await exportReviewCommand('rev_abcd1234', 'markdown', markdownPath);
        const markdown = await readFile(markdownPath, 'utf8');
        assert.match(markdown, /## Review Summary/);

        const jsonPath = join(dir, 'review.json');
        await exportReviewCommand('rev_abcd1234', 'json', jsonPath);
        const json = await readFile(jsonPath, 'utf8');
        assert.match(json, /"id": "rev_abcd1234"/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
  }
}
