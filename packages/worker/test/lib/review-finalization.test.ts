import { strict as assert } from 'assert';
import { finalizeFailedReviewIfCurrent, finalizeSuccessfulReview } from '../../src/lib/review-runner/finalization.js';

export async function runReviewFinalizationTests(): Promise<void> {
  let nonStatusQueryTouched = false;
  let eventSeq = 0;

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

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  eventSeq += 1;
                  return { last_event_seq: eventSeq };
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
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
    } as never,
    { expectedAttemptCount: 1 }
  );

  assert.equal(nonStatusQueryTouched, false);

  let zeroFindingStatusPersisted = false;
  let zeroFindingFindingsTouched = false;
  const zeroFindingRerunEnv = {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 'rev_zero_findings',
                    workspace_id: 'ws_zero_findings',
                    deployment_id: 'dep_zero_findings',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'running',
                    idempotency_key: 'idem_zero_findings',
                    request_payload_json: JSON.stringify({
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                      },
                    }),
                    request_payload_sha256: 'z'.repeat(64),
                    account_id: null,
                    provenance_json: '{}',
                    derived_policy_json: null,
                    approved_policy_json: null,
                    approved_policy_sha256: null,
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-04-09T00:00:00.000Z',
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-04-09T00:00:00.000Z',
                    updated_at: '2026-04-09T00:00:30.000Z',
                  };
                },
              };
            },
          };
        }

        if (/SELECT\s+COALESCE\(MAX\(/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return { max_seq: 0 };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return { last_event_seq: 1 };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET status = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  zeroFindingStatusPersisted = true;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/DELETE FROM review_findings\s+WHERE review_id = \?/i.test(sql) || /INSERT INTO review_findings/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  zeroFindingFindingsTouched = true;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  await finalizeSuccessfulReview(
    zeroFindingRerunEnv as never,
    'rev_zero_findings',
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
    } as never,
    { expectedAttemptCount: 1 }
  );

  assert.equal(zeroFindingStatusPersisted, true);
  assert.equal(zeroFindingFindingsTouched, true);

  let persistedSuccessfulReport = false;
  let preservedStartedAt: string | null | undefined;
  let staleRecoveredEventSeq = 0;
  const staleRecoveredEnv = {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 'rev_retrying',
                    workspace_id: 'ws_retrying',
                    deployment_id: 'dep_retrying',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'queued',
                    idempotency_key: 'idem_retrying',
                    request_payload_json: JSON.stringify({
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                      },
                    }),
                    request_payload_sha256: 'b'.repeat(64),
                    account_id: null,
                    provenance_json: '{}',
                    derived_policy_json: null,
                    approved_policy_json: null,
                    approved_policy_sha256: null,
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-04-09T00:00:00.000Z',
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: 'retry_scheduled',
                    error_message: 'stale recovery requested',
                    created_at: '2026-04-09T00:00:00.000Z',
                    updated_at: '2026-04-09T00:02:00.000Z',
                  };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  staleRecoveredEventSeq += 1;
                  return { last_event_seq: staleRecoveredEventSeq };
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET/i.test(sql)) {
          persistedSuccessfulReport = true;
          return {
            bind(...values: Array<string | number | null>) {
              return {
                async run() {
                  preservedStartedAt = (values[2] as string | null | undefined) ?? undefined;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  await finalizeSuccessfulReview(
    staleRecoveredEnv as never,
    'rev_retrying',
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
    } as never,
    { expectedAttemptCount: 1 }
  );

  assert.equal(persistedSuccessfulReport, false);
  assert.equal(preservedStartedAt, undefined);

  let persistedTimedOutReport = false;
  let timeoutEventSeq = 0;
  const timedOutEnv = {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 'rev_timed_out',
                    workspace_id: 'ws_timed_out',
                    deployment_id: 'dep_timed_out',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'failed',
                    idempotency_key: 'idem_timed_out',
                    request_payload_json: JSON.stringify({
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                      },
                    }),
                    request_payload_sha256: 'c'.repeat(64),
                    account_id: null,
                    provenance_json: '{}',
                    derived_policy_json: null,
                    approved_policy_json: null,
                    approved_policy_sha256: null,
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-04-09T00:00:00.000Z',
                    finished_at: '2026-04-09T00:03:00.000Z',
                    report_json: null,
                    markdown_summary: null,
                    error_code: 'review_execution_timeout',
                    error_message: 'timed out while queued',
                    created_at: '2026-04-09T00:00:00.000Z',
                    updated_at: '2026-04-09T00:03:00.000Z',
                  };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  timeoutEventSeq += 1;
                  return { last_event_seq: timeoutEventSeq };
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET/i.test(sql)) {
          persistedTimedOutReport = true;
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  await finalizeSuccessfulReview(
    timedOutEnv as never,
    'rev_timed_out',
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
    } as never,
    { expectedAttemptCount: 1 }
  );

  assert.equal(persistedTimedOutReport, false);

  let statusTransitionApplied = false;
  let findingsTouched = 0;
  let successEventEmitted = false;
  let finalizeStartedEmitted = false;
  const racedManualFailEnv = {
    DB: {
      prepare(sql: string) {
        if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return {
                    id: 'rev_manual_fail_race',
                    workspace_id: 'ws_manual_fail_race',
                    deployment_id: 'dep_manual_fail_race',
                    target_type: 'workspace_deployment',
                    mode: 'report_only',
                    status: 'running',
                    idempotency_key: 'idem_manual_fail_race',
                    request_payload_json: JSON.stringify({
                      provenance: {
                        repo: 'dayhaysoos/nimbus',
                        branch: 'main',
                      },
                    }),
                    request_payload_sha256: 'd'.repeat(64),
                    account_id: null,
                    provenance_json: '{}',
                    derived_policy_json: null,
                    approved_policy_json: null,
                    approved_policy_sha256: null,
                    last_event_seq: 0,
                    attempt_count: 1,
                    started_at: '2026-04-09T00:00:00.000Z',
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: '2026-04-09T00:00:00.000Z',
                    updated_at: '2026-04-09T00:00:30.000Z',
                  };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return { last_event_seq: 1 };
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind(_reviewId: string, _seq: number, eventType: string) {
              return {
                async run() {
                  if (eventType === 'review_finalize_started') {
                    finalizeStartedEmitted = true;
                  }
                  if (eventType === 'review_succeeded') {
                    successEventEmitted = true;
                  }
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/DELETE FROM review_findings\s+WHERE review_id = \?/i.test(sql) || /INSERT INTO review_findings/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  findingsTouched += 1;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET status = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  statusTransitionApplied = false;
                  return { success: true, meta: { changes: 0 } };
                },
              };
            },
          };
        }

        if (/SELECT\s+COALESCE\(MAX\(/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  return { max_seq: 0 };
                },
              };
            },
          };
        }

        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  await finalizeSuccessfulReview(
    racedManualFailEnv as never,
    'rev_manual_fail_race',
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
    } as never,
    { expectedAttemptCount: 1 }
  );

  assert.equal(statusTransitionApplied, false);
  assert.equal(findingsTouched, 2);
  assert.equal(finalizeStartedEmitted, false);
  assert.equal(successEventEmitted, false);

  let failedEventEmitted = false;
  const losingFailedFinalize = await finalizeFailedReviewIfCurrent(
    {
      DB: {
        prepare(sql: string) {
          if (/UPDATE review_runs/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    return { success: true, meta: { changes: 0 } };
                  },
                };
              },
            };
          }
          if (/INSERT INTO review_events/i.test(sql)) {
            return {
              bind() {
                return {
                  async run() {
                    failedEventEmitted = true;
                    return { success: true, meta: { changes: 1 } };
                  },
                };
              },
            };
          }
          return {
            bind() {
              return {
                async first() {
                  return null;
                },
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
    } as never,
    'rev_manual_fail_race',
    {
      errorCode: 'review_execution_failed',
      message: 'fetch failed',
      expectedAttemptCount: 1,
    }
  );

  assert.equal(losingFailedFinalize, false);
  assert.equal(failedEventEmitted, false);
}
