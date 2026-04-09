import { strict as assert } from 'assert';
import { finalizeSuccessfulReview } from '../../src/lib/review-runner/finalization.js';

export async function runReviewFinalizationTests(): Promise<void> {
  let nonStatusQueryTouched = false;

  const env = {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 'rev_abcd1234',
                    workspace_id: 'ws_123',
                    deployment_id: 'dep_123',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'failed',
                    idempotency_key: 'idem_123',
                    request_payload_json: JSON.stringify({
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                      },
                    }),
                    request_payload_sha256: 'a'.repeat(64),
                    account_id: null,
                    provenance_json: '{}',
                    derived_policy_json: null,
                    approved_policy_json: null,
                    approved_policy_sha256: null,
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-04-09T00:00:00.000Z',
                    finished_at: '2026-04-09T00:01:00.000Z',
                    report_json: null,
                    markdown_summary: null,
                    error_code: 'review_execution_aborted',
                    error_message: 'manual fail',
                    created_at: '2026-04-09T00:00:00.000Z',
                    updated_at: '2026-04-09T00:01:00.000Z',
                  };
                },
              };
            },
          };
        }

        nonStatusQueryTouched = true;
        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };

  await finalizeSuccessfulReview(
    env as never,
    'rev_abcd1234',
    { provenance: { repo: 'dayhaysoos/nimbus', branch: 'main' } },
    {
      summary: {
        recommendation: 'approve',
        riskLevel: 'low',
        findingCounts: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      },
      findings: [],
      evidence: [],
      provenance: {
        repo: 'dayhaysoos/nimbus',
        branch: 'main',
        sessionIds: [],
        policyItems: [],
        promptSummary: '',
        transcriptUrl: null,
      },
      markdownSummary: '',
      summaryText: '',
      furtherPassesLowYield: true,
    } as never
  );

  assert.equal(nonStatusQueryTouched, false);
}
