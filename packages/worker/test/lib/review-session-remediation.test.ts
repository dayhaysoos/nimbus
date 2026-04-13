import { strict as assert } from 'assert';
import { continueReviewSessionAfterSuccessfulPass } from '../../src/lib/review-runner/session-remediation.js';
import { setReviewAnalysisSandboxResolverForTests } from '../../src/lib/review-analysis.js';
import { setWorkspaceTaskSandboxResolverForTests } from '../../src/lib/workspace-task-runner.js';
import type { ReviewReport, ReviewRunResponse } from '../../src/types.js';

interface TestState {
  changed: boolean;
  fileContent: string;
  workspaceStatus: 'ready' | 'deleted';
  reviewEvents: Array<{ eventType: string; payload: unknown }>;
  workspaceTaskEvents: Array<{ eventType: string; payload: unknown }>;
  reviewRunRecords: Map<string, Record<string, unknown>>;
  reviewRunIdempotency: Map<string, { reviewId: string; requestPayloadSha256: string; expiresAt: string }>;
  workspaceTasks: Map<string, Record<string, unknown>>;
  workspaceTaskIdempotency: Map<string, { taskId: string; requestPayloadSha256: string; expiresAt: string }>;
  sessionStopReason: string | null;
  sessionActiveReviewId: string | null;
  sessionLatestReviewId: string | null;
  sessionPassCount: number;
  failReviewEventsFor: Set<string>;
  reviewContextInPrimaryBucket: boolean;
}

function createBaseReport(findings: ReviewReport['findings'], followUpReviewScore: 1 | 2 | 3): ReviewReport {
  return {
    summary: {
      recommendation: findings.length > 0 ? 'comment' : 'approve',
      riskLevel: findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical') ? 'high' : 'medium',
      findingCounts: {
        info: findings.filter((finding) => finding.severity === 'info').length,
        low: findings.filter((finding) => finding.severity === 'low').length,
        medium: findings.filter((finding) => finding.severity === 'medium').length,
        high: findings.filter((finding) => finding.severity === 'high').length,
        critical: findings.filter((finding) => finding.severity === 'critical').length,
      },
    },
    findings,
    evidence: [],
    provenance: {
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      sessionIds: ['session_slice4'],
      policyItems: [],
      promptSummary: 'Slice 4 remediation test',
      reviewContextRef: {
        id: 'rctx_slice4',
        r2Key: 'review-context-key',
      },
      followUpReview: {
        score: followUpReviewScore,
        rationale: 'test rationale',
        source: 'model-self-assessment',
      },
    },
    markdownSummary: null,
    summaryText: findings.length > 0 ? 'Findings present.' : 'No actionable findings.',
    furtherPassesLowYield: followUpReviewScore === 1,
    intent: {
      goal: null,
      constraints: [],
      decisions: [],
    },
  };
}

function createReviewResponse(): ReviewRunResponse {
  return {
    id: 'review_current',
    workspaceId: 'ws_slice4',
    deploymentId: 'dep_slice4',
    sessionId: 'session_slice4',
    target: {
      type: 'workspace_deployment',
      workspaceId: 'ws_slice4',
      deploymentId: 'dep_slice4',
    },
    mode: 'report_only',
    status: 'succeeded',
    policyMode: 'none',
    reviewBasis: 'checkpoint',
    idempotencyKey: 'idem_current',
    attemptCount: 1,
    startedAt: '2026-04-12T12:00:00.000Z',
    finishedAt: '2026-04-12T12:01:00.000Z',
    createdAt: '2026-04-12T12:00:00.000Z',
    updatedAt: '2026-04-12T12:01:00.000Z',
    findings: [],
    evidence: [],
    provenance: {
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      sessionIds: ['session_slice4'],
      policyItems: [],
      promptSummary: 'Slice 4 remediation test',
      reviewContextRef: {
        id: 'rctx_slice4',
        r2Key: 'review-context-key',
      },
    },
    markdownSummary: null,
  };
}

function tryHandleWriteFileCommand(
  command: string,
  onWrite: (contents: string) => void
): boolean {
  if (!command.includes("with open(path, 'w', encoding='utf-8')")) {
    return false;
  }

  const match = command.match(/content = (".*?")\nos\.makedirs/s);
  if (!match) {
    return false;
  }

  onWrite(JSON.parse(match[1]));
  return true;
}

function createRemediationEnv(): { env: Record<string, unknown>; state: TestState } {
  const state: TestState = {
    changed: false,
    fileContent: 'export const value = 1;\n',
    workspaceStatus: 'ready',
    reviewEvents: [],
    workspaceTaskEvents: [],
    reviewRunRecords: new Map<string, Record<string, unknown>>([
      [
        'review_current',
        {
          id: 'review_current',
          workspace_id: 'ws_slice4',
          deployment_id: 'dep_slice4',
          session_id: 'session_slice4',
          target_type: 'workspace_deployment',
          mode: 'report_only',
          status: 'succeeded',
          idempotency_key: 'idem_current',
          request_payload_json: JSON.stringify({
            target: { type: 'workspace_deployment', workspaceId: 'ws_slice4', deploymentId: 'dep_slice4' },
            mode: 'report_only',
            reviewBasis: 'checkpoint',
            provenance: {
              repo: 'dayhaysoos/nimbus',
              branch: 'main',
            },
          }),
          request_payload_sha256: 'hash_current',
          provenance_json: JSON.stringify({ promptSummary: 'Slice 4 remediation test' }),
          repo: 'dayhaysoos/nimbus',
          branch: 'main',
          derived_policy_json: null,
          approved_policy_json: null,
          approved_policy_sha256: null,
          last_event_seq: 0,
          attempt_count: 1,
          started_at: '2026-04-12T12:00:00.000Z',
          finished_at: '2026-04-12T12:01:00.000Z',
          report_json: null,
          markdown_summary: null,
          error_code: null,
          error_message: null,
          created_at: '2026-04-12T12:00:00.000Z',
          updated_at: '2026-04-12T12:01:00.000Z',
        },
      ],
    ]),
    reviewRunIdempotency: new Map(),
    workspaceTasks: new Map(),
    workspaceTaskIdempotency: new Map(),
    sessionStopReason: null,
    sessionActiveReviewId: 'review_current',
    sessionLatestReviewId: 'review_current',
    sessionPassCount: 1,
    failReviewEventsFor: new Set<string>(),
    reviewContextInPrimaryBucket: true,
  };

  const reviewContextObject = {
    async text() {
      return JSON.stringify({
        checkpoint: {
          branch: 'entire/checkpoints/v1',
        },
        retrieval: {
          changedFiles: [{ path: 'src/value.ts' }],
          relatedFiles: [],
              coChange: {
                source: 'local_git',
                lookbackSessions: 5,
                topN: 20,
                sessionsScanned: 1,
              },
              relatedByChangedPath: {
                'src/value.ts': [
                  {
                    path: 'src/helper.ts',
                    frequency: 2,
                    sessionIds: ['sess_001', 'sess_002'],
                  },
                ],
              },
            },
          });
        },
      };

  const env = {
    AGENT_PROVIDER: 'cloudflare_agents_sdk',
    AGENT_MODEL: 'claude-test',
    AGENT_SDK_URL: 'https://agent.example.com',
    WORKSPACE_AGENT_RUNTIME_ENABLED: 'true',
    REVIEW_AGENT_MAX_STEPS: '4',
    WORKSPACE_AGENT_MAX_STEPS: '4',
    WORKSPACE_AGENT_MAX_RETRIES: '0',
    REVIEW_CONTEXTS: {
      async get(key: string) {
        if (key !== 'review-context-key') {
          return null;
        }
        return state.reviewContextInPrimaryBucket ? reviewContextObject : null;
      },
    },
    WORKSPACE_ARTIFACTS: {
      async get(key: string) {
        if (key !== 'review-context-key') {
          return null;
        }
        return state.reviewContextInPrimaryBucket ? null : reviewContextObject;
      },
    },
    DB: {
      prepare(sql: string) {
        if (/SELECT key, value FROM runtime_flags/i.test(sql)) {
          return {
            async all<T>() {
              return { results: [] as unknown as T[] };
            },
          };
        }

        if (/SELECT \* FROM review_sessions WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'session_slice4',
                    workspace_id: 'ws_slice4',
                    anchor_deployment_id: 'dep_slice4',
                    repo: 'dayhaysoos/nimbus',
                    branch: 'main',
                    initial_review_basis: 'checkpoint',
                    anchor_commit_sha: 'a'.repeat(40),
                    anchor_checkpoint_id: 'chk_slice4',
                    source_project_root: '.',
                    active_review_id: state.sessionActiveReviewId,
                    latest_review_id: state.sessionLatestReviewId,
                    pass_count: state.sessionPassCount,
                    stop_reason: state.sessionStopReason,
                    account_id: 'acct_123',
                    created_at: '2026-04-12T12:00:00.000Z',
                    updated_at: '2026-04-12T12:01:00.000Z',
                    finished_at: null,
                  } as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE session_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async all<T>() {
                  return {
                    results: Array.from(state.reviewRunRecords.values())
                      .filter((record) => record.session_id === 'session_slice4')
                      .map((record) => ({
                        id: record.id,
                        session_id: record.session_id,
                        status: record.status,
                        request_payload_json: record.request_payload_json,
                        created_at: record.created_at,
                        started_at: record.started_at,
                        finished_at: record.finished_at,
                      })),
                  } as unknown as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'ws_slice4',
                    status: state.workspaceStatus,
                    source_type: 'checkpoint',
                    checkpoint_id: 'chk_slice4',
                    commit_sha: 'a'.repeat(40),
                    source_ref: 'main',
                    source_project_root: '.',
                    source_bundle_key: 'bundle_key',
                    source_bundle_sha256: 'b'.repeat(64),
                    source_bundle_bytes: 123,
                    sandbox_id: 'workspace-ws_slice4',
                    baseline_ready: 1,
                    error_code: null,
                    error_message: null,
                    last_deployment_id: 'dep_slice4',
                    last_deployment_status: 'succeeded',
                    last_deployed_url: 'https://example.com',
                    last_deployed_at: '2026-04-12T12:00:00.000Z',
                    last_deployment_error_code: null,
                    last_deployment_error_message: null,
                    last_event_seq: 0,
                    created_at: '2026-04-12T12:00:00.000Z',
                    updated_at: '2026-04-12T12:00:00.000Z',
                    deleted_at: state.workspaceStatus === 'deleted' ? '2026-04-12T12:05:00.000Z' : null,
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT account_id FROM workspaces WHERE id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return { account_id: 'acct_123' } as T;
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_deployments WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind() {
              return {
                async first<T>() {
                  return {
                    id: 'dep_slice4',
                    workspace_id: 'ws_slice4',
                    status: 'succeeded',
                    provider: 'simulated',
                    idempotency_key: 'idem_deploy',
                    request_payload_json: '{}',
                    request_payload_sha256: 'hash_deploy',
                    max_retries: 1,
                    attempt_count: 1,
                    source_snapshot_sha256: 'sha',
                    source_bundle_key: 'bundle_key',
                    provenance_json: '{}',
                    provider_deployment_id: 'provider_dep',
                    deployed_url: 'https://example.com',
                    last_event_seq: 0,
                    cancel_requested_at: null,
                    started_at: '2026-04-12T12:00:00.000Z',
                    finished_at: '2026-04-12T12:01:00.000Z',
                    duration_ms: 60000,
                    result_json: '{}',
                    toolchain_json: null,
                    dependency_cache_key: null,
                    dependency_cache_hit: 0,
                    remediations_json: '[]',
                    error_code: null,
                    error_message: null,
                    created_at: '2026-04-12T12:00:00.000Z',
                    updated_at: '2026-04-12T12:01:00.000Z',
                  } as T;
                },
              };
            },
          };
        }

        if (/SELECT review_id, request_payload_sha256, expires_at\s+FROM review_run_idempotency/i.test(sql)) {
          return {
            bind(_workspaceId: string, idempotencyKey: string) {
              return {
                async first<T>() {
                  const existing = state.reviewRunIdempotency.get(idempotencyKey);
                  return (existing
                    ? {
                        review_id: existing.reviewId,
                        request_payload_sha256: existing.requestPayloadSha256,
                        expires_at: existing.expiresAt,
                      }
                    : null) as T;
                },
              };
            },
          };
        }

        if (/FROM review_runs\s+WHERE workspace_id = \?\s+AND idempotency_key = \?/i.test(sql)) {
          return {
            bind(_workspaceId: string, idempotencyKey: string) {
              return {
                async first<T>() {
                  const record = Array.from(state.reviewRunRecords.values()).find((row) => row.idempotency_key === idempotencyKey);
                  return (record ?? null) as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_runs/i.test(sql)) {
          return {
            bind(
              id: string,
              workspaceId: string,
              deploymentId: string,
              sessionId: string | null,
              targetType: string,
              mode: string,
              status: string,
              idempotencyKey: string,
              requestPayloadJson: string,
              requestPayloadSha256: string,
              accountId: string | null,
              provenanceJson: string,
              repo: string,
              branch: string,
              derivedPolicyJson: string | null,
              approvedPolicyJson: string | null,
              approvedPolicySha256: string | null,
              createdAt: string,
              updatedAt: string
            ) {
              return {
                async first<T>() {
                  const record = {
                    id,
                    workspace_id: workspaceId,
                    deployment_id: deploymentId,
                    session_id: sessionId,
                    target_type: targetType,
                    mode,
                    status,
                    idempotency_key: idempotencyKey,
                    request_payload_json: requestPayloadJson,
                    request_payload_sha256: requestPayloadSha256,
                    account_id: accountId,
                    provenance_json: provenanceJson,
                    repo,
                    branch,
                    derived_policy_json: derivedPolicyJson,
                    approved_policy_json: approvedPolicyJson,
                    approved_policy_sha256: approvedPolicySha256,
                    last_event_seq: 0,
                    attempt_count: 0,
                    started_at: null,
                    finished_at: null,
                    report_json: null,
                    markdown_summary: null,
                    error_code: null,
                    error_message: null,
                    created_at: createdAt,
                    updated_at: updatedAt,
                  };
                  state.reviewRunRecords.set(id, record);
                  return record as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_run_idempotency/i.test(sql)) {
          return {
            bind(_id: string, _workspaceId: string, idempotencyKey: string, reviewId: string, requestPayloadSha256: string, expiresAt: string) {
              return {
                async run() {
                  state.reviewRunIdempotency.set(idempotencyKey, { reviewId, requestPayloadSha256, expiresAt });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_sessions\s+SET active_review_id = \?/i.test(sql)) {
          return {
            bind(activeReviewId: string, latestReviewId: string, repeatedReviewId: string) {
              return {
                async run() {
                  const previousLatestReviewId = state.sessionLatestReviewId;
                  state.sessionActiveReviewId = activeReviewId;
                  state.sessionLatestReviewId = latestReviewId;
                  state.sessionPassCount = previousLatestReviewId === repeatedReviewId ? state.sessionPassCount : state.sessionPassCount + 1;
                  state.sessionStopReason = null;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_sessions\s+SET active_review_id = NULL/i.test(sql)) {
          return {
            bind(
              latestReviewId: string | null,
              stopReason: string,
              _finishedAt: string,
              _updatedAt: string,
              _sessionId: string,
              expectedLatestReviewId: string | null
            ) {
              return {
                async run() {
                  if (expectedLatestReviewId !== null && state.sessionLatestReviewId !== expectedLatestReviewId) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  state.sessionActiveReviewId = null;
                  state.sessionLatestReviewId = latestReviewId ?? state.sessionLatestReviewId;
                  state.sessionStopReason = stopReason;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE review_runs SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind(reviewId: string) {
              return {
                async first<T>() {
                  const record = state.reviewRunRecords.get(reviewId);
                  if (!record) {
                    return null as T;
                  }
                  const nextSeq = Number(record.last_event_seq ?? 0) + 1;
                  record.last_event_seq = nextSeq;
                  return { last_event_seq: nextSeq } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO review_events/i.test(sql)) {
          return {
            bind(_reviewId: string, _seq: number, eventType: string, payloadJson: string) {
              return {
                async run() {
                  if (state.failReviewEventsFor.has(eventType)) {
                    throw new Error(`simulated review event failure: ${eventType}`);
                  }
                  state.reviewEvents.push({ eventType, payload: JSON.parse(payloadJson) });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT task_id, request_payload_sha256, expires_at\s+FROM workspace_task_idempotency/i.test(sql)) {
          return {
            bind(_workspaceId: string, idempotencyKey: string) {
              return {
                async first<T>() {
                  const existing = state.workspaceTaskIdempotency.get(idempotencyKey);
                  return (existing
                    ? {
                        task_id: existing.taskId,
                        request_payload_sha256: existing.requestPayloadSha256,
                        expires_at: existing.expiresAt,
                      }
                    : null) as T;
                },
              };
            },
          };
        }

        if (/FROM workspace_tasks\s+WHERE workspace_id = \?\s+AND idempotency_key = \?/i.test(sql)) {
          return {
            bind(_workspaceId: string, idempotencyKey: string) {
              return {
                async first<T>() {
                  const record = Array.from(state.workspaceTasks.values()).find((row) => row.idempotency_key === idempotencyKey);
                  return (record ?? null) as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_tasks/i.test(sql)) {
          return {
            bind(
              id: string,
              workspaceId: string,
              prompt: string,
              provider: string,
              model: string,
              idempotencyKey: string,
              requestPayloadJson: string,
              requestPayloadSha256: string,
              maxSteps: number,
              maxRetries: number,
              actorId: string | null,
              toolPolicyJson: string,
              createdAt: string,
              updatedAt: string
            ) {
              return {
                async first<T>() {
                  const record = {
                    id,
                    workspace_id: workspaceId,
                    status: 'queued',
                    prompt,
                    provider,
                    model,
                    idempotency_key: idempotencyKey,
                    request_payload_json: requestPayloadJson,
                    request_payload_sha256: requestPayloadSha256,
                    max_steps: maxSteps,
                    max_retries: maxRetries,
                    actor_id: actorId,
                    tool_policy_json: toolPolicyJson,
                    attempt_count: 0,
                    last_event_seq: 0,
                    started_at: null,
                    finished_at: null,
                    cancel_requested_at: null,
                    result_json: null,
                    error_code: null,
                    error_message: null,
                    created_at: createdAt,
                    updated_at: updatedAt,
                  };
                  state.workspaceTasks.set(id, record);
                  return record as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_task_idempotency/i.test(sql)) {
          return {
            bind(_id: string, _workspaceId: string, idempotencyKey: string, taskId: string, requestPayloadSha256: string, expiresAt: string) {
              return {
                async run() {
                  state.workspaceTaskIdempotency.set(idempotencyKey, { taskId, requestPayloadSha256, expiresAt });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspace_tasks\s+SET status = 'running'/i.test(sql)) {
          return {
            bind(_startedAt: string, _updatedAt: string, taskId: string) {
              return {
                async run() {
                  const task = state.workspaceTasks.get(taskId);
                  if (!task || task.status !== 'queued') {
                    return { success: true, meta: { changes: 0 } };
                  }
                  task.status = 'running';
                  task.attempt_count = Number(task.attempt_count ?? 0) + 1;
                  task.started_at = task.started_at ?? '2026-04-12T12:02:00.000Z';
                  task.updated_at = '2026-04-12T12:02:00.000Z';
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/SELECT \* FROM workspace_tasks WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind(taskId: string) {
              return {
                async first<T>() {
                  return (state.workspaceTasks.get(taskId) ?? null) as T;
                },
              };
            },
          };
        }

        if (/SELECT request_payload_json FROM workspace_tasks WHERE id = \?/i.test(sql)) {
          return {
            bind(taskId: string) {
              return {
                async first<T>() {
                  const task = state.workspaceTasks.get(taskId);
                  return (task ? { request_payload_json: task.request_payload_json } : null) as T;
                },
              };
            },
          };
        }

        if (/SELECT tool_policy_json FROM workspace_tasks WHERE id = \? AND workspace_id = \?/i.test(sql)) {
          return {
            bind(taskId: string) {
              return {
                async first<T>() {
                  const task = state.workspaceTasks.get(taskId);
                  return (task ? { tool_policy_json: task.tool_policy_json } : null) as T;
                },
              };
            },
          };
        }

        if (/UPDATE workspace_tasks SET last_event_seq = last_event_seq \+ 1/i.test(sql)) {
          return {
            bind(taskId: string) {
              return {
                async first<T>() {
                  const task = state.workspaceTasks.get(taskId);
                  if (!task) {
                    return null as T;
                  }
                  const nextSeq = Number(task.last_event_seq ?? 0) + 1;
                  task.last_event_seq = nextSeq;
                  return { last_event_seq: nextSeq } as T;
                },
              };
            },
          };
        }

        if (/INSERT INTO workspace_task_events/i.test(sql)) {
          return {
            bind(_workspaceId: string, _taskId: string, _seq: number, eventType: string, payloadJson: string) {
              return {
                async run() {
                  state.workspaceTaskEvents.push({ eventType, payload: JSON.parse(payloadJson) });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }

        if (/UPDATE workspace_tasks SET/i.test(sql)) {
          return {
            bind(status: string, updatedAt: string, ...rest: unknown[]) {
              return {
                async run() {
                  const taskId = String(rest.at(-2));
                  const task = state.workspaceTasks.get(taskId);
                  if (!task) {
                    return { success: true, meta: { changes: 0 } };
                  }
                  task.status = status;
                  task.updated_at = updatedAt;
                  for (const value of rest) {
                    if (typeof value === 'string' && value.startsWith('{')) {
                      task.result_json = value;
                    }
                    if (value === null || typeof value === 'string') {
                      if (value === 'task_execution_failed' || value === 'retry_scheduled') {
                        task.error_code = value;
                      }
                    }
                  }
                  if (status === 'succeeded') {
                    task.finished_at = '2026-04-12T12:03:00.000Z';
                    task.error_code = null;
                    task.error_message = null;
                  }
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
              async all() {
                return { results: [] };
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

  return { env, state };
}

export async function runReviewSessionRemediationTests(): Promise<void> {
  const originalFetch = globalThis.fetch;

  {
    const { env, state } = createRemediationEnv();
    const sandbox = {
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --cached -M HEAD')) {
          return {
            stdout: state.changed
              ? 'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'
              : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (
          tryHandleWriteFileCommand(command, (contents) => {
            state.fileContent = contents;
            state.changed = true;
          })
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile(_path: string, contents: string) {
        state.fileContent = contents;
        state.changed = true;
        return {};
      },
      async destroy() {
        return undefined;
      },
    };
    setWorkspaceTaskSandboxResolverForTests(async () => sandbox as never);
    setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'write_file',
              args: { path: 'src/value.ts', content: 'export const value = 2;\n' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'Updated src/value.ts to address the reported logic issue.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          description: 'value.ts returns the wrong constant.',
          suggestedFix: 'Update the exported value to 2.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.ok(result.nextReviewId);
    assert.equal(state.fileContent, 'export const value = 2;\n');
    assert.equal(state.workspaceTaskEvents.some((event) => event.eventType === 'task_succeeded'), true);
    assert.equal(state.reviewEvents.some((event) => event.eventType === 'review_auto_remediation_completed'), true);
    assert.equal(state.sessionPassCount, 2);
    const followup = result.nextReviewId ? state.reviewRunRecords.get(result.nextReviewId) : null;
    assert.ok(followup);
    assert.equal(String(followup?.request_payload_json).includes('"reviewBasis":"environment"'), true);
    assert.equal(String(followup?.request_payload_json).includes('"changedFileCount":1'), true);
    assert.equal(String(followup?.request_payload_json).includes('"localCochange":{"source":"local_git"'), true);
  }

  {
    const { env, state } = createRemediationEnv();
    state.reviewContextInPrimaryBucket = false;
    const sandbox = {
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --cached -M HEAD')) {
          return {
            stdout: state.changed
              ? 'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'
              : '',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile(_path: string, contents: string) {
        state.fileContent = contents;
        state.changed = true;
        return {};
      },
      async destroy() {
        return undefined;
      },
    };
    setWorkspaceTaskSandboxResolverForTests(async () => sandbox as never);
    setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'write_file',
              args: { path: 'src/value.ts', content: 'export const value = 2;\n' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'Updated src/value.ts to address the reported logic issue.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          description: 'value.ts returns the wrong constant.',
          suggestedFix: 'Update the exported value to 2.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    const followup = result.nextReviewId ? state.reviewRunRecords.get(result.nextReviewId) : null;
    assert.ok(followup);
    assert.equal(String(followup?.request_payload_json).includes('"localCochange":{"source":"local_git"'), true);
  }

  {
    const { env, state } = createRemediationEnv();
    const sandbox = {
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --cached -M HEAD')) {
          return {
            stdout: state.changed
              ? 'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'
              : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (
          tryHandleWriteFileCommand(command, (contents) => {
            state.fileContent = contents;
            state.changed = true;
          })
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile(_path: string, contents: string) {
        state.fileContent = contents;
        state.changed = true;
        return {};
      },
      async destroy() {
        return undefined;
      },
    };
    setWorkspaceTaskSandboxResolverForTests(async () => sandbox as never);
    setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'write_file',
              args: { path: 'src/value.ts', content: 'export const value = 2;\n' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'Updated src/value.ts to address the reported high-severity logic issue.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'high',
          category: 'logic',
          passType: 'single',
          description: 'value.ts returns the wrong constant and breaks the helper for valid inputs.',
          suggestedFix: 'Update the exported value to 2.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.ok(result.nextReviewId);
    assert.equal(state.fileContent, 'export const value = 2;\n');
    assert.equal(state.workspaceTaskEvents.some((event) => event.eventType === 'task_succeeded'), true);
    assert.equal(state.reviewEvents.some((event) => event.eventType === 'review_auto_remediation_completed'), true);
    assert.equal(state.sessionPassCount, 2);
  }

  {
    const { env, state } = createRemediationEnv();
    state.changed = true;
    const sandbox = {
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --cached -M HEAD')) {
          return {
            stdout:
              'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile() {
        return {};
      },
      async destroy() {
        return undefined;
      },
    };
    setWorkspaceTaskSandboxResolverForTests(async () => sandbox as never);
    setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'No safe edits were made.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          description: 'value.ts returns the wrong constant.',
          suggestedFix: 'Update the exported value to 2.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.sessionStopReason, 'no_progress');
    assert.equal(state.sessionPassCount, 1);
  }

  {
    const { env, state } = createRemediationEnv();
    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'high',
          category: 'breaking-change',
          passType: 'single',
          description: 'Applying this fix requires a schema migration.',
          suggestedFix: 'Add the migration and update the contract.',
          locations: [{ filePath: 'db/schema.sql', startLine: 1, endLine: 10 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.workspaceTasks.size, 0);
    assert.equal(state.sessionStopReason, 'risky_fix_requires_approval');
    assert.equal(state.reviewEvents.some((event) => event.eventType === 'review_auto_remediation_skipped'), true);
  }

  {
    const { env, state } = createRemediationEnv();
    state.workspaceStatus = 'deleted';
    const review = createReviewResponse();
    const report = createBaseReport([], 1);

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.sessionStopReason, 'initial_pass_completed');
    assert.equal(state.sessionActiveReviewId, null);
    assert.equal(state.sessionLatestReviewId, 'review_current');
    assert.equal(state.reviewEvents.some((event) => event.eventType === 'review_auto_remediation_failed'), false);
  }

  {
    const { env, state } = createRemediationEnv();
    state.sessionPassCount = 2;
    state.sessionActiveReviewId = 'review_followup';
    state.sessionLatestReviewId = 'review_followup';
    state.reviewRunRecords.set('review_followup', {
      id: 'review_followup',
      workspace_id: 'ws_slice4',
      deployment_id: 'dep_slice4',
      session_id: 'session_slice4',
      target_type: 'workspace_deployment',
      mode: 'report_only',
      status: 'succeeded',
      idempotency_key: 'idem_followup',
      request_payload_json: JSON.stringify({
        target: { type: 'workspace_deployment', workspaceId: 'ws_slice4', deploymentId: 'dep_slice4' },
        mode: 'report_only',
        reviewBasis: 'environment',
        provenance: {
          repo: 'dayhaysoos/nimbus',
          branch: 'main',
        },
      }),
      request_payload_sha256: 'hash_followup',
      provenance_json: JSON.stringify({ promptSummary: 'Slice 4 remediation test' }),
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      derived_policy_json: null,
      approved_policy_json: null,
      approved_policy_sha256: null,
      last_event_seq: 0,
      attempt_count: 1,
      started_at: '2026-04-12T12:04:00.000Z',
      finished_at: '2026-04-12T12:05:00.000Z',
      report_json: null,
      markdown_summary: null,
      error_code: null,
      error_message: null,
      created_at: '2026-04-12T12:04:00.000Z',
      updated_at: '2026-04-12T12:05:00.000Z',
    });
    const review = {
      ...createReviewResponse(),
      id: 'review_followup',
      reviewBasis: 'environment' as const,
    };
    const report = createBaseReport([], 1);

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.sessionStopReason, 'followup_pass_completed');
    assert.equal(state.sessionActiveReviewId, null);
    assert.equal(state.sessionLatestReviewId, 'review_followup');
  }

  {
    const { env, state } = createRemediationEnv();
    state.failReviewEventsFor.add('review_auto_remediation_skipped');
    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'high',
          category: 'breaking-change',
          passType: 'single',
          description: 'Applying this fix requires a schema migration.',
          suggestedFix: 'Add the migration and update the contract.',
          locations: [{ filePath: 'db/schema.sql', startLine: 1, endLine: 10 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.sessionStopReason, 'risky_fix_requires_approval');
  }

  {
    const { env, state } = createRemediationEnv();
    state.sessionActiveReviewId = 'review_manual';
    state.sessionLatestReviewId = 'review_manual';
    state.sessionPassCount = 2;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          description: 'A safe follow-up fix exists.',
          suggestedFix: 'Adjust the implementation minimally.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.workspaceTasks.size, 0);
    assert.equal(state.sessionLatestReviewId, 'review_manual');
    assert.equal(state.sessionActiveReviewId, 'review_manual');
  }

  {
    const { env, state } = createRemediationEnv();
    const sandbox = {
      async exec(command: string) {
        if (command.includes('git rev-parse --verify HEAD')) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command.includes('git diff --cached -M HEAD')) {
          return {
            stdout: state.changed
              ? 'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'
              : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (
          tryHandleWriteFileCommand(command, (contents) => {
            state.fileContent = contents;
            state.changed = true;
            state.sessionActiveReviewId = 'review_manual';
            state.sessionLatestReviewId = 'review_manual';
            state.sessionPassCount = 2;
          })
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async writeFile(_path: string, contents: string) {
        state.fileContent = contents;
        state.changed = true;
        state.sessionActiveReviewId = 'review_manual';
        state.sessionLatestReviewId = 'review_manual';
        state.sessionPassCount = 2;
        return {};
      },
      async destroy() {
        return undefined;
      },
    };
    setWorkspaceTaskSandboxResolverForTests(async () => sandbox as never);
    setReviewAnalysisSandboxResolverForTests(async () => sandbox as never);
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(
          JSON.stringify({
            action: {
              type: 'tool',
              tool: 'write_file',
              args: { path: 'src/value.ts', content: 'export const value = 2;\n' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          action: {
            type: 'final',
            summary: 'Updated src/value.ts.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const review = createReviewResponse();
    const report = createBaseReport(
      [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          description: 'value.ts returns the wrong constant.',
          suggestedFix: 'Update the exported value to 2.',
          locations: [{ filePath: 'src/value.ts', startLine: 1, endLine: 1 }],
        },
      ],
      3
    );

    const result = await continueReviewSessionAfterSuccessfulPass(env as never, review, report);
    assert.equal(result.nextReviewId, null);
    assert.equal(state.sessionLatestReviewId, 'review_manual');
    assert.equal(state.sessionActiveReviewId, 'review_manual');
    assert.equal(state.sessionPassCount, 2);
    const sessionAdvancedEvent = state.reviewEvents.find(
      (event) =>
        event.eventType === 'review_auto_remediation_skipped' &&
        typeof event.payload === 'object' &&
        event.payload !== null &&
        (event.payload as { reason?: string }).reason === 'session_state_advanced'
    );
    assert.ok(sessionAdvancedEvent);
  }

  globalThis.fetch = originalFetch;
  setWorkspaceTaskSandboxResolverForTests(null);
  setReviewAnalysisSandboxResolverForTests(null);
}
