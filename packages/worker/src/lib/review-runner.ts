import type { Env, ReviewFinding, ReviewReport, ReviewRunResponse, ReviewSeverity } from '../types.js';
import {
  appendReviewEvent,
  claimReviewRunForExecution,
  getReviewRun,
  getReviewRunRequestPayload,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  listWorkspaceDeploymentEvents,
  replaceReviewFindings,
  updateReviewRunStatus,
} from './db.js';

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

const REVIEW_MAX_RETRIES = 2;
const REVIEW_SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function transientReviewFailure(message: string): boolean {
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset)/i.test(message);
}

function statusFromEventType(eventType: string, payload: Record<string, unknown>): 'passed' | 'failed' | 'warning' | 'info' {
  if (eventType === 'validation_started') {
    return 'info';
  }
  if (eventType === 'deployment_provider_status' || eventType === 'deployment_provider_created') {
    const providerStatus = typeof payload.status === 'string' ? payload.status : null;
    if (providerStatus === 'succeeded') {
      return 'passed';
    }
    if (providerStatus === 'failed' || providerStatus === 'cancelled') {
      return 'failed';
    }
    return 'info';
  }
  if (eventType.includes('failed')) {
    return 'failed';
  }
  if (eventType.includes('skipped') || eventType.includes('missing') || eventType.includes('fallback')) {
    return 'warning';
  }
  if (eventType.includes('succeeded') || eventType.includes('status') || eventType.includes('started')) {
    return 'passed';
  }
  return 'info';
}

function markdownSection(title: string, items: string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return [`## ${title}`, '', ...items.map((item) => `- ${item}`), ''];
}
function buildReviewMarkdown(report: ReviewReport): string {
  const evidenceLines = report.evidence.map((item) => `${item.label} (${item.status})`);
  const provenanceLines: string[] = [];
  if (report.provenance.promptSummary) {
    provenanceLines.push(report.provenance.promptSummary);
  }
  if (report.provenance.sessionIds.length > 0) {
    provenanceLines.push(`Sessions: ${report.provenance.sessionIds.join(', ')}`);
  }

  const findingLines =
    report.findings.length === 0
      ? ['No actionable findings were emitted for this deployment review.']
      : report.findings.map((finding) => {
          const location = finding.locations[0] ? `${finding.locations[0].path}:${finding.locations[0].line}` : 'deployment-level';
          return `[${finding.severity}/${finding.confidence}] ${finding.title} (${location})`;
        });

  return [
    '## Review Summary',
    '',
    `- Recommendation: ${report.summary.recommendation}`,
    `- Risk level: ${report.summary.riskLevel}`,
    `- Findings: ${report.findings.length}`,
    '',
    ...markdownSection('Intent', [
      report.intent.goal ?? 'No explicit goal captured.',
      ...report.intent.constraints.map((item) => `Constraint: ${item}`),
      ...report.intent.decisions.map((item) => `Decision: ${item}`),
    ]),
    ...markdownSection('Evidence', evidenceLines),
    ...markdownSection('Findings', findingLines),
    ...markdownSection('Provenance', provenanceLines),
  ]
    .join('\n')
    .trim();
}

function buildFindingId(reviewId: string, index: number): string {
  return `f_${reviewId}_${String(index).padStart(3, '0')}`;
}

async function buildWorkspaceDeploymentReport(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>
): Promise<ReviewReport> {
  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found for review target ${review.deploymentId}`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentEvents = await listWorkspaceDeploymentEvents(env.DB, review.workspaceId, review.deploymentId, 0, 500);
  const reviewPolicy = asRecord(payload.policy);
  const reviewFormat = asRecord(payload.format);
  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const requestValidation = asRecord(deploymentRequest.validation);
  const requestProvenance = asRecord(deploymentRequest.provenance);
  const severityThreshold = typeof reviewPolicy.severityThreshold === 'string' ? reviewPolicy.severityThreshold : 'low';
  const maxFindings = parsePositiveInteger(reviewPolicy.maxFindings, 100, 500);
  const includeProvenance = parseBoolean(reviewPolicy.includeProvenance, true);
  const includeValidationEvidence = parseBoolean(reviewPolicy.includeValidationEvidence, true);
  const includeMarkdownSummary = parseBoolean(reviewFormat.includeMarkdownSummary, true);

  const severityFloor = REVIEW_SEVERITY_RANK[severityThreshold as ReviewSeverity] ?? REVIEW_SEVERITY_RANK.low;
  const findings = deploymentEvents
    .flatMap<ReviewFinding>((event, index) => {
      const eventPayload = asRecord(event.payload);
      if (event.eventType === 'deployment_validation_tool_missing') {
        const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
        return [
          {
            id: buildFindingId(review.id, index + 1),
            severity: 'medium' as const,
            confidence: 'high' as const,
            title: `Validation tool missing for ${step}`,
            description: typeof eventPayload.message === 'string' ? eventPayload.message : 'Validation tool missing in runtime.',
            conditions: `Observed during ${step} validation for deployment ${review.deploymentId}.`,
            locations: [],
            suggestedFix: {
              kind: 'text' as const,
              value: `Install the required ${step} validation tool in the deployment runtime or disable that validation step explicitly.`,
            },
            evidenceRefs: [`ev_${event.seq}`],
          },
        ];
      }
      if (event.eventType === 'validation_skipped') {
        const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
        return [
          {
            id: buildFindingId(review.id, index + 1),
            severity: 'low' as const,
            confidence: 'medium' as const,
            title: `Validation skipped for ${step}`,
            description: `Nimbus skipped ${step} validation while preparing this deployment review.`,
            conditions: typeof eventPayload.reason === 'string' ? eventPayload.reason : 'skip reason not recorded',
            locations: [],
            suggestedFix: {
              kind: 'text' as const,
              value: `Run the ${step} validation in the deployment path or document why it is intentionally skipped.`,
            },
            evidenceRefs: [`ev_${event.seq}`],
          },
        ];
      }
      if (event.eventType === 'deployment_toolchain_unknown_fallback') {
        return [
          {
            id: buildFindingId(review.id, index + 1),
            severity: 'low' as const,
            confidence: 'medium' as const,
            title: 'Toolchain detection fell back to unknown defaults',
            description: 'Deployment completed after a toolchain fallback, which may hide package-manager-specific issues.',
            conditions: `Observed while reviewing deployment ${review.deploymentId}.`,
            locations: [],
            suggestedFix: {
              kind: 'text' as const,
              value: 'Declare an explicit package manager and lockfile so future deploys and reviews use deterministic tooling.',
            },
            evidenceRefs: [`ev_${event.seq}`],
          },
        ];
      }
      return [];
    })
    .filter((finding) => REVIEW_SEVERITY_RANK[finding.severity] >= severityFloor)
    .sort((left, right) => REVIEW_SEVERITY_RANK[right.severity] - REVIEW_SEVERITY_RANK[left.severity])
    .slice(0, maxFindings);

  const evidence = includeValidationEvidence
    ? deploymentEvents
    .filter((event) => {
      return [
        'validation_started',
        'validation_skipped',
        'deployment_validation_tool_missing',
        'deployment_provider_created',
        'deployment_provider_status',
        'deployment_succeeded',
      ].includes(event.eventType);
    })
    .map((event) => ({
      id: `ev_${event.seq}`,
      type: event.eventType,
      label: event.eventType.replaceAll('_', ' '),
      status: statusFromEventType(event.eventType, asRecord(event.payload)),
      metadata: asRecord(event.payload),
    }))
    : [];

  if (includeValidationEvidence && deployment.deployedUrl) {
    evidence.push({
      id: 'ev_deployed_url',
      type: 'deploy_probe',
      label: 'Deployed URL present',
      status: 'passed',
      metadata: { url: deployment.deployedUrl },
    });
  }
  if (
    includeValidationEvidence &&
    (typeof resultArtifact.sourceBundleKey === 'string' || typeof resultArtifact.sourceSnapshotSha256 === 'string')
  ) {
    evidence.push({
      id: 'ev_artifact',
      type: 'artifact',
      label: 'Deployment artifact recorded',
      status: 'info',
      metadata: resultArtifact,
    });
  }

  const riskLevel: ReviewSeverity = findings.some((finding) => finding.severity === 'critical')
    ? 'critical'
    : findings.some((finding) => finding.severity === 'high')
      ? 'high'
      : findings.some((finding) => finding.severity === 'medium')
        ? 'medium'
        : 'low';
  const summary = {
    riskLevel,
    findingCounts: {
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
    },
    recommendation: findings.length > 0 ? ('comment' as const) : ('approve' as const),
  };

  const intent = {
    goal:
      typeof requestProvenance.note === 'string' && requestProvenance.note.trim()
        ? requestProvenance.note.trim()
        : `Assess workspace deployment ${review.deploymentId} for review-first handoff readiness.`,
    constraints: [
      'Non-mutating review only.',
      `Target limited to ${review.target.type}.`,
      requestValidation.runTestsIfPresent === false ? 'Tests were not required during deployment validation.' : 'Tests were eligible during deployment validation.',
      requestValidation.runBuildIfPresent === false ? 'Build validation was not required during deployment validation.' : 'Build validation was eligible during deployment validation.',
    ],
    decisions: [
      `Deployment provider: ${deployment.provider}.`,
      `Review mode: ${review.mode}.`,
      typeof resultProvenance.trigger === 'string'
        ? `Deployment trigger: ${resultProvenance.trigger}.`
        : typeof requestProvenance.trigger === 'string'
          ? `Deployment trigger: ${requestProvenance.trigger}.`
          : 'Deployment trigger was not recorded.',
    ],
  };

  const report: ReviewReport = {
    summary,
    findings,
    intent,
    evidence,
    provenance: includeProvenance
      ? {
          sessionIds: parseStringArray(requestProvenance.sessionIds),
          promptSummary:
            typeof payload.mode === 'string'
              ? `Review generated in ${payload.mode} mode for deployment ${review.deploymentId}.`
              : `Review generated for deployment ${review.deploymentId}.`,
          transcriptUrl: null,
        }
      : {
          sessionIds: [],
          promptSummary: null,
          transcriptUrl: null,
        },
    markdownSummary: null,
  };
  if (includeMarkdownSummary) {
    report.markdownSummary = buildReviewMarkdown(report);
  }
  return report;
}

async function executeReviewRun(env: Env, review: ReviewRunResponse, payload: Record<string, unknown>): Promise<ReviewReport> {
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_started',
    payload: {
      targetType: review.target.type,
      mode: review.mode,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_preflight_completed',
    payload: {
      ok: true,
    },
  });
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_analysis_started',
    payload: {
      deploymentId: review.deploymentId,
      workspaceId: review.workspaceId,
    },
  });

  const target = asRecord(payload.target);
  const targetType = typeof target.type === 'string' ? target.type : review.target.type;
  if (targetType !== 'workspace_deployment') {
    throw new Error(`Unsupported review target type: ${targetType}`);
  }

  const report = await buildWorkspaceDeploymentReport(env, review, payload);
  for (const finding of report.findings) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_finding_emitted',
      payload: {
        findingId: finding.id,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
      },
    });
  }

  return report;
}

export async function processReviewRun(env: Env, reviewId: string): Promise<void> {
  const claimed = await claimReviewRunForExecution(env.DB, reviewId);
  if (!claimed) {
    const existing = await getReviewRun(env.DB, reviewId);
    if (existing?.status === 'running') {
      throw new QueueRetryError('Review run is already running; defer redelivery');
    }
    return;
  }

  let review: ReviewRunResponse | null = null;
  try {
    review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return;
    }

    const payload = await getReviewRunRequestPayload(env.DB, reviewId);
    if (!payload) {
      await updateReviewRunStatus(env.DB, reviewId, 'failed', {
        errorCode: 'review_not_found',
        errorMessage: 'Review request payload no longer exists',
      });
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: 'review_not_found',
          message: 'Review request payload no longer exists',
        },
      });
      return;
    }

    const report = await executeReviewRun(env, review, payload);
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_finalize_started',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await replaceReviewFindings(env.DB, reviewId, report.findings);
    await updateReviewRunStatus(env.DB, reviewId, 'succeeded', {
      report,
      markdownSummary: report.markdownSummary,
      errorCode: null,
      errorMessage: null,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_succeeded',
      payload: {
        recommendation: report.summary.recommendation,
        findingCount: report.findings.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latest = await getReviewRun(env.DB, reviewId);
    const attemptCount = latest?.attemptCount ?? review?.attemptCount ?? 0;

    if ((error instanceof QueueRetryError || transientReviewFailure(message)) && attemptCount <= REVIEW_MAX_RETRIES) {
      await replaceReviewFindings(env.DB, reviewId, []);
      await updateReviewRunStatus(env.DB, reviewId, 'queued', {
        report: null,
        markdownSummary: null,
        startedAt: null,
        finishedAt: null,
        errorCode: 'retry_scheduled',
        errorMessage: message,
      });
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_retry_scheduled',
        payload: {
          attemptCount,
          maxRetries: REVIEW_MAX_RETRIES,
        },
      });
      throw new QueueRetryError('Review transient failure; retry requested');
    }

    await updateReviewRunStatus(env.DB, reviewId, 'failed', {
      errorCode: 'review_execution_failed',
      errorMessage: message,
    });
    try {
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: 'review_execution_failed',
          message,
        },
      });
    } catch {
      // Best-effort terminal event.
    }
  }
}

export async function runReviewInlineWithRetries(env: Env, reviewId: string, maxCycles = 4): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    try {
      await processReviewRun(env, reviewId);
    } catch {
      // Retry scheduling is inferred from persisted status.
    }

    const latest = await getReviewRun(env.DB, reviewId);
    if (!latest) {
      return;
    }
    if (latest.status !== 'queued') {
      return;
    }
    if (latest.error?.code !== 'retry_scheduled') {
      return;
    }
  }
}

export function shouldRetryReviewError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return transientReviewFailure(message);
}
