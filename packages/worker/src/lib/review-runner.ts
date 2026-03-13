import type {
  Env,
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunResponse,
  ReviewSeverity,
} from '../types.js';
import {
  appendReviewEvent,
  claimReviewRunForExecution,
  getReviewRun,
  getReviewRunRequestPayload,
  getWorkspaceArtifactById,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  getWorkspaceOperation,
  getWorkspaceTask,
  listWorkspaceDeploymentEvents,
  replaceReviewFindings,
  updateReviewRunStatus,
} from './db.js';
import { formatReviewAnalysisError, runWorkspaceDeploymentAgentAnalysis } from './review-analysis.js';

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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
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

function redactReviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = value
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/gh[spu]_[a-z0-9_]+/gi, '[REDACTED_TOKEN]')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)([^\s,]+)/gi, '$1[REDACTED]');
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
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

function mergeFindings(primary: ReviewFinding[], secondary: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const merged: ReviewFinding[] = [];

  for (const finding of [...primary, ...secondary]) {
    const key = [finding.title.trim().toLowerCase(), finding.locations[0]?.path ?? '', String(finding.locations[0]?.line ?? 0)].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(finding);
  }

  return merged;
}

function buildHeuristicFindings(
  review: ReviewRunResponse,
  deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>
): ReviewFinding[] {
  return deploymentEvents.flatMap<ReviewFinding>((event, index) => {
    const eventPayload = asRecord(event.payload);
    if (event.eventType === 'deployment_validation_tool_missing') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          id: buildFindingId(review.id, index + 1),
          severity: 'medium',
          confidence: 'high',
          title: `Validation tool missing for ${step}`,
          description: typeof eventPayload.message === 'string' ? eventPayload.message : 'Validation tool missing in runtime.',
          conditions: `Observed during ${step} validation for deployment ${review.deploymentId}.`,
          locations: [],
          suggestedFix: {
            kind: 'text',
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
          severity: 'low',
          confidence: 'medium',
          title: `Validation skipped for ${step}`,
          description: `Nimbus skipped ${step} validation while preparing this deployment review.`,
          conditions: typeof eventPayload.reason === 'string' ? eventPayload.reason : 'skip reason not recorded',
          locations: [],
          suggestedFix: {
            kind: 'text',
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
          severity: 'low',
          confidence: 'medium',
          title: 'Toolchain detection fell back to unknown defaults',
          description: 'Deployment completed after a toolchain fallback, which may hide package-manager-specific issues.',
          conditions: `Observed while reviewing deployment ${review.deploymentId}.`,
          locations: [],
          suggestedFix: {
            kind: 'text',
            value: 'Declare an explicit package manager and lockfile so future deploys and reviews use deterministic tooling.',
          },
          evidenceRefs: [`ev_${event.seq}`],
        },
      ];
    }
    return [];
  });
}

function buildEvidence(
  deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>,
  deployment: { deployedUrl: string | null },
  resultArtifact: Record<string, unknown>,
  includeValidationEvidence: boolean,
  agentEvidence?: ReviewEvidenceItem | null
): ReviewEvidenceItem[] {
  const evidence: ReviewEvidenceItem[] = includeValidationEvidence
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
  if (agentEvidence) {
    evidence.push(agentEvidence);
  }

  return evidence;
}

function deriveRiskLevel(findings: ReviewFinding[], fallback: ReviewSeverity = 'low'): ReviewSeverity {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'high';
  }
  if (findings.some((finding) => finding.severity === 'medium')) {
    return 'medium';
  }
  if (findings.some((finding) => finding.severity === 'low')) {
    return 'low';
  }
  return fallback;
}

function deriveRecommendation(findings: ReviewFinding[]): ReviewRecommendation {
  const riskLevel = deriveRiskLevel(findings);
  if (riskLevel === 'critical' || riskLevel === 'high') {
    return 'request_changes';
  }
  if (riskLevel === 'medium' || riskLevel === 'low') {
    return findings.length > 0 ? 'comment' : 'approve';
  }
  return 'approve';
}

function sanitizeIntentBlock(intent: {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}): { goal: string | null; constraints: string[]; decisions: string[] } {
  return {
    goal: redactReviewText(intent.goal),
    constraints: intent.constraints.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    decisions: intent.decisions.map((item) => redactReviewText(item) ?? '').filter(Boolean),
  };
}

async function loadAuthoritativeDeploymentDiff(
  env: Env,
  workspaceId: string,
  operationId: string | null,
  reviewDiffArtifactId: string | null
): Promise<{ source: 'artifact_patch'; artifactId: string; patch: string } | null> {
  const getArtifactObject = async (objectKey: string): Promise<R2ObjectBody | null> => {
    const fromArtifacts = env.WORKSPACE_ARTIFACTS ? await env.WORKSPACE_ARTIFACTS.get(objectKey) : null;
    if (fromArtifacts) {
      return fromArtifacts;
    }
    return env.SOURCE_BUNDLES ? await env.SOURCE_BUNDLES.get(objectKey) : null;
  };

  if (reviewDiffArtifactId) {
    const reviewArtifact = await getWorkspaceArtifactById(env.DB, workspaceId, reviewDiffArtifactId);
    if (reviewArtifact && reviewArtifact.artifact.type === 'patch') {
      const object = await getArtifactObject(reviewArtifact.objectKey);
      if (!object) {
        return null;
      }
      return {
        source: 'artifact_patch',
        artifactId: reviewDiffArtifactId,
        patch: await object.text(),
      };
    }
  }

  if (!operationId) {
    return null;
  }

  const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
  if (!operation || operation.type !== 'export_patch' || operation.status !== 'succeeded') {
    return null;
  }

  const result = asRecord(operation.result);
  const artifactId = typeof result.artifactId === 'string' ? result.artifactId.trim() : '';
  if (!artifactId) {
    return null;
  }

  const artifact = await getWorkspaceArtifactById(env.DB, workspaceId, artifactId);
  if (!artifact || artifact.artifact.type !== 'patch') {
    return null;
  }

  const object = await getArtifactObject(artifact.objectKey);
  if (!object) {
    return null;
  }

  return {
    source: 'artifact_patch',
    artifactId,
    patch: await object.text(),
  };
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
  const intentSessionContext = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext)).slice(0, 8);
  const provenanceTaskId = typeof resultProvenance.taskId === 'string'
    ? resultProvenance.taskId
    : typeof requestProvenance.taskId === 'string'
      ? requestProvenance.taskId
      : null;
  const provenanceTask = provenanceTaskId ? await getWorkspaceTask(env.DB, review.workspaceId, provenanceTaskId) : null;
  const taskResult = asRecord(provenanceTask?.result);
  const severityThreshold = typeof reviewPolicy.severityThreshold === 'string' ? reviewPolicy.severityThreshold : 'low';
  const maxFindings = parsePositiveInteger(reviewPolicy.maxFindings, 100, 500);
  const includeProvenance = parseBoolean(reviewPolicy.includeProvenance, true);
  const includeValidationEvidence = parseBoolean(reviewPolicy.includeValidationEvidence, true);
  const includeMarkdownSummary = parseBoolean(reviewFormat.includeMarkdownSummary, true);

  const baseGoal =
    typeof provenanceTask?.prompt === 'string' && provenanceTask.prompt.trim()
      ? provenanceTask.prompt.trim()
      : typeof requestProvenance.note === 'string' && requestProvenance.note.trim()
        ? requestProvenance.note.trim()
      : `Assess workspace deployment ${review.deploymentId} for review-first handoff readiness.`;
  const baseConstraints = [
    'Non-mutating review only.',
    `Target limited to ${review.target.type}.`,
    requestValidation.runTestsIfPresent === false
      ? 'Tests were not required during deployment validation.'
      : 'Tests were eligible during deployment validation.',
    requestValidation.runBuildIfPresent === false
      ? 'Build validation was not required during deployment validation.'
      : 'Build validation was eligible during deployment validation.',
  ];
  const baseDecisions = [
    `Deployment provider: ${deployment.provider}.`,
    `Review mode: ${review.mode}.`,
    provenanceTask ? `Source task model: ${provenanceTask.model}.` : '',
    typeof taskResult.summary === 'string' && taskResult.summary.trim() ? `Source task summary: ${taskResult.summary.trim()}.` : '',
    typeof resultProvenance.trigger === 'string'
      ? `Deployment trigger: ${resultProvenance.trigger}.`
      : typeof requestProvenance.trigger === 'string'
        ? `Deployment trigger: ${requestProvenance.trigger}.`
        : 'Deployment trigger was not recorded.',
    parseStringArray(requestProvenance.sessionIds).length > 0
      ? `Related Entire sessions: ${parseStringArray(requestProvenance.sessionIds).join(', ')}.`
      : '',
    intentSessionContext.length > 0 ? `Prompt-history context excerpts provided: ${intentSessionContext.length}.` : '',
  ];

  const heuristicFindings = buildHeuristicFindings(review, deploymentEvents);
  const analysisEvidence = buildEvidence(deploymentEvents, deployment, resultArtifact, true);
  const provenanceOperationId = typeof resultProvenance.operationId === 'string'
    ? resultProvenance.operationId
    : typeof requestProvenance.operationId === 'string'
      ? requestProvenance.operationId
      : null;
  const reviewDiffArtifactId = typeof resultArtifact.reviewDiffArtifactId === 'string'
    ? resultArtifact.reviewDiffArtifactId
    : typeof resultProvenance.reviewDiffArtifactId === 'string'
      ? resultProvenance.reviewDiffArtifactId
      : typeof requestProvenance.reviewDiffArtifactId === 'string'
        ? requestProvenance.reviewDiffArtifactId
        : null;
  const authoritativeDiff = await loadAuthoritativeDeploymentDiff(
    env,
    review.workspaceId,
    provenanceOperationId,
    reviewDiffArtifactId
  );
  let agentAnalysis: Awaited<ReturnType<typeof runWorkspaceDeploymentAgentAnalysis>> = null;
  const reviewAgentEnabled = Boolean((env.AGENT_SDK_URL ?? '').trim());
  const deploymentSourceBundleKey =
    typeof resultArtifact.sourceBundleKey === 'string' && resultArtifact.sourceBundleKey.trim()
      ? resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;
  try {
    const promptGoal = provenanceTask?.prompt?.trim() || baseGoal;
    if (reviewAgentEnabled && deploymentSourceBundleKey) {
      await appendReviewEvent(env.DB, {
        reviewId: review.id,
        eventType: 'review_analysis_agent_started',
        payload: {
          provider: 'cloudflare_agents_sdk',
          model: (env.AGENT_MODEL ?? 'claude-3-7-sonnet').trim() || 'claude-3-7-sonnet',
        },
      });
    }
    if (reviewAgentEnabled && deploymentSourceBundleKey) {
      agentAnalysis = await runWorkspaceDeploymentAgentAnalysis(env, {
        reviewId: review.id,
        workspaceId: review.workspaceId,
        deploymentId: review.deploymentId,
        deploymentSandboxId: `review-snapshot-${review.id}`,
        sourceBundleKey: deploymentSourceBundleKey,
        authoritativeDiffSnapshot: authoritativeDiff
          ? {
        source: authoritativeDiff.source,
        artifactId: authoritativeDiff.artifactId,
        patch: authoritativeDiff.patch,
      }
          : undefined,
        goal: promptGoal,
        constraints: baseConstraints,
        decisions: baseDecisions.filter(Boolean),
        intentSessionContext,
        evidenceCatalog: analysisEvidence.map((item) => ({
          id: item.id,
          type: item.type,
          label: item.label,
          status: item.status,
        })),
        deploymentSummary: {
          provider: deployment.provider,
          deployedUrl: deployment.deployedUrl,
          validationSummary: JSON.stringify(requestValidation),
        },
        rootListing: {},
        diffSnapshot: {},
      });
    }
    if (agentAnalysis) {
      await appendReviewEvent(env.DB, {
        reviewId: review.id,
        eventType: 'review_analysis_agent_completed',
        payload: {
          provider: agentAnalysis.provider,
          model: agentAnalysis.model,
          stepsExecuted: agentAnalysis.stepsExecuted,
          findingCount: agentAnalysis.findings.length,
        },
      });
    } else if (reviewAgentEnabled && !deploymentSourceBundleKey) {
      await appendReviewEvent(env.DB, {
        reviewId: review.id,
        eventType: 'review_analysis_fallback',
        payload: {
          message: 'Deployment snapshot unavailable; skipping agent analysis',
        },
      });
    }
  } catch (error) {
    const message = formatReviewAnalysisError(error);
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_fallback',
      payload: {
        message,
      },
    });
  }

  const severityFloor = REVIEW_SEVERITY_RANK[severityThreshold as ReviewSeverity] ?? REVIEW_SEVERITY_RANK.low;
  const mergedFindings = mergeFindings(agentAnalysis?.findings ?? [], heuristicFindings)
    .filter((finding) => REVIEW_SEVERITY_RANK[finding.severity] >= severityFloor)
    .sort((left, right) => REVIEW_SEVERITY_RANK[right.severity] - REVIEW_SEVERITY_RANK[left.severity])
    .slice(0, maxFindings);
  const agentEvidence = agentAnalysis
    ? {
        id: 'ev_review_agent',
        type: 'analysis_agent',
        label: `AI review analysis via ${agentAnalysis.provider}`,
        status: 'info' as const,
        metadata: {
          model: agentAnalysis.model,
          stepsExecuted: agentAnalysis.stepsExecuted,
          usedTools: agentAnalysis.usedTools,
        },
      }
    : null;
  const evidence = buildEvidence(deploymentEvents, deployment, resultArtifact, includeValidationEvidence, agentEvidence);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const findings = mergedFindings.map((finding) => ({
    ...finding,
    evidenceRefs: finding.evidenceRefs.filter((reference) => evidenceIds.has(reference)),
  }));

  const riskLevel = deriveRiskLevel(findings, 'low');
  const recommendation = deriveRecommendation(findings);
  const summary = {
    riskLevel,
    findingCounts: {
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
    },
    recommendation,
  };

  const intent = sanitizeIntentBlock({
    goal: agentAnalysis?.intent?.goal ?? baseGoal,
    constraints: Array.from(new Set([...(agentAnalysis?.intent?.constraints ?? []), ...baseConstraints])),
    decisions: Array.from(new Set([...(agentAnalysis?.intent?.decisions ?? []), ...baseDecisions])),
  });

  const promptSummary = redactReviewText(
    (typeof requestProvenance.note === 'string' ? requestProvenance.note.trim() : null) ||
      `Review generated in ${review.mode} mode for deployment ${review.deploymentId}.`
  );
  const transcriptUrl =
    typeof requestProvenance.transcriptUrl === 'string' && requestProvenance.transcriptUrl.trim()
      ? requestProvenance.transcriptUrl.trim()
      : null;

  const report: ReviewReport = {
    summary,
    findings,
    intent,
    evidence,
    provenance: includeProvenance
      ? {
          sessionIds: parseStringArray(requestProvenance.sessionIds),
          promptSummary,
          transcriptUrl,
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
