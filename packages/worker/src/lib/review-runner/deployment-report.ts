import type {
  Env,
  ReviewContext,
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunResponse,
  ReviewSeverity,
} from '../../types.js';
import {
  appendReviewEvent,
  getWorkspaceArtifactById,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  getWorkspaceOperation,
  getWorkspaceTask,
  listWorkspaceDeploymentEvents,
} from '../db.js';
import { extractPolicyItemsFromIntentContext, redactReviewText } from '../review-redaction.js';
import { runWorkspaceDeploymentAgentAnalysis } from '../review-analysis.js';
import { intentSummaryFromApprovedPolicy, summarizeReviewIntentPolicy } from './intent-summary.js';
import {
  buildEvidence,
  buildHeuristicFindings,
  buildReviewMarkdown,
  deriveRecommendation,
  deriveRiskLevel,
  mergeFindings,
  sanitizeIntentBlock,
} from './report.js';
import {
  asRecord,
  mergeProvenance,
  parseStringArray,
  readOptionalString,
  uniqueStrings,
  resolveReviewAnalysisModel,
} from './context-helpers.js';
import { ReviewContextAssemblyError } from './cochange.js';
import { loadAuthoritativeDeploymentDiff } from './context-diff.js';
import type { ReviewRunExecutionOptions } from './shared.js';

const REVIEW_SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  info: 0,
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const LARGE_DIFF_ADVISORY_THRESHOLD = 30;
const DEFAULT_REVIEW_ANALYSIS_TIMEOUT_MS = 4 * 60 * 1000;

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  createError: () => Error
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Builds the final review report for a successful workspace deployment, including agent analysis,
 * heuristic findings, evidence, intent, and provenance metadata.
 */
export async function buildWorkspaceDeploymentReport(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  reviewContext: ReviewContext,
  options?: ReviewRunExecutionOptions
): Promise<ReviewReport> {
  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found for review target ${review.deploymentId}`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentEvents = await listWorkspaceDeploymentEvents(env.DB, review.workspaceId, review.deploymentId, 0, 500);
  const reviewPolicy = asRecord(payload.policy);
  const reviewFormat = asRecord(payload.format);
  const reviewAnalysisModel = resolveReviewAnalysisModel(payload, env);
  const result = asRecord(deployment.result);
  const resultProvenance = asRecord(result.provenance);
  const resultArtifact = asRecord(result.artifact);
  const requestValidation = asRecord(deploymentRequest.validation);
  const requestProvenance = mergeProvenance(asRecord(deploymentRequest.provenance), asRecord(payload.provenance));
  const intentSessionContext = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext)).slice(0, 8);
  const approvedPolicy = review.approvedPolicy ?? null;
  const rawSessionPromptsFromProvenance =
    typeof requestProvenance.rawSessionPrompts === 'string' && requestProvenance.rawSessionPrompts.trim()
      ? requestProvenance.rawSessionPrompts.trim()
      : null;
  const rawSessionPrompts = rawSessionPromptsFromProvenance ?? (intentSessionContext.length > 0 ? intentSessionContext.join('\n') : null);
  const intentSummaryModel = readOptionalString(requestProvenance.intentSummaryModel);
  if (!approvedPolicy && !rawSessionPrompts) {
    throw new ReviewContextAssemblyError(
      'review_context_prompt_history_missing',
      'Review prompt-history context is required for intent summarization. Ensure deployment/review provenance includes rawSessionPrompts.'
    );
  }
  const derivedIntentSummary = approvedPolicy
    ? intentSummaryFromApprovedPolicy(approvedPolicy)
    : await summarizeReviewIntentPolicy(env, {
        rawSessionPrompts: rawSessionPrompts ?? '',
        intentSessionContext,
        openrouterApiKey: readOptionalString(options?.openrouterApiKey),
        intentSummaryModel,
      });
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
  const changedFileCount = reviewContext.retrieval.coChange.filesConsidered;
  const advisories =
    changedFileCount > LARGE_DIFF_ADVISORY_THRESHOLD
      ? [`Large diff detected (${changedFileCount} files). Consider smaller, focused commits for higher quality reviews.`]
      : [];

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
  const authoritativeDiff = await loadAuthoritativeDeploymentDiff(env, review.workspaceId, provenanceOperationId, reviewDiffArtifactId);
  let agentAnalysis: Awaited<ReturnType<typeof runWorkspaceDeploymentAgentAnalysis>> = null;
  const reviewAgentEnabled = Boolean((env.AGENT_SDK_URL ?? '').trim());
  const deploymentSourceBundleKey =
    typeof resultArtifact.sourceBundleKey === 'string' && resultArtifact.sourceBundleKey.trim()
      ? resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;
  const promptGoal = approvedPolicy?.goal?.trim() || provenanceTask?.prompt?.trim() || baseGoal;
  const promptConstraints = approvedPolicy ? Array.from(new Set([...approvedPolicy.constraints, ...baseConstraints])) : baseConstraints;
  const promptDecisions = approvedPolicy
    ? Array.from(new Set([...approvedPolicy.prohibitions.map((item) => `Must not: ${item}`), ...baseDecisions]))
    : baseDecisions;

  if (reviewAgentEnabled && deploymentSourceBundleKey) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_agent_started',
      payload: {
        provider: 'cloudflare_agents_sdk',
        model: reviewAnalysisModel,
      },
    });

    const analysisTimeoutMs = parseTimeoutMs(env.REVIEW_ANALYSIS_TIMEOUT_MS, DEFAULT_REVIEW_ANALYSIS_TIMEOUT_MS);
    try {
      agentAnalysis = await withTimeout(
        runWorkspaceDeploymentAgentAnalysis(env, {
          reviewId: review.id,
          workspaceId: review.workspaceId,
          deploymentId: review.deploymentId,
          deploymentSandboxId: `review-snapshot-${review.id}`,
          sourceBundleKey: deploymentSourceBundleKey,
          modelOverride: reviewAnalysisModel,
          authoritativeDiffSnapshot: authoritativeDiff
            ? {
                source: authoritativeDiff.source,
                artifactId: authoritativeDiff.artifactId,
                patch: authoritativeDiff.patch,
              }
            : undefined,
          goal: promptGoal,
          constraints: promptConstraints,
          decisions: promptDecisions.filter(Boolean),
          intentSessionContext,
          intentSummary: derivedIntentSummary,
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
          reviewContext,
          rootListing: {},
          diffSnapshot: {},
          onLifecycleEvent: async (eventType, eventPayload) => {
            await appendReviewEvent(env.DB, {
              reviewId: review.id,
              eventType,
              payload: eventPayload,
            });
          },
          openrouterApiKey: readOptionalString(options?.openrouterApiKey),
        }),
        analysisTimeoutMs,
        () => new Error(`Review analysis timed out after ${analysisTimeoutMs}ms while waiting for model/provider response`)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|timeout/i.test(message)) {
        await appendReviewEvent(env.DB, {
          reviewId: review.id,
          eventType: 'review_analysis_timeout',
          payload: {
            timeoutMs: analysisTimeoutMs,
            message,
          },
        });
      }
      throw error;
    }

    if (!agentAnalysis) {
      throw new Error('Review analysis did not produce output.');
    }

    if (agentAnalysis.validation.fallbackApplied) {
      throw new Error(`Review analysis produced non-authoritative fallback output (${agentAnalysis.validation.fallbackReason ?? 'unknown'}).`);
    }

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
  }

  if (reviewAgentEnabled && !deploymentSourceBundleKey) {
    throw new Error('Deployment snapshot unavailable; review analysis cannot proceed without source bundle.');
  }
  if (reviewAgentEnabled && !agentAnalysis) {
    throw new Error('Review analysis did not produce output.');
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
  const findings = mergedFindings;

  const riskLevel = deriveRiskLevel(findings, 'low');
  const recommendation = deriveRecommendation(findings);
  const summary = {
    riskLevel,
    findingCounts: {
      info: findings.filter((finding) => finding.severity === 'info').length,
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
    },
    recommendation,
  };

  const intent = sanitizeIntentBlock({
    goal: agentAnalysis?.intent?.goal ?? promptGoal,
    constraints: Array.from(new Set([...(agentAnalysis?.intent?.constraints ?? []), ...promptConstraints])),
    decisions: Array.from(new Set([...(agentAnalysis?.intent?.decisions ?? []), ...promptDecisions])),
  });

  const promptSummary = redactReviewText(
    (typeof requestProvenance.note === 'string' ? requestProvenance.note.trim() : null) ||
      `Review generated in ${review.mode} mode for deployment ${review.deploymentId}.`
  );
  const transcriptUrl =
    typeof requestProvenance.transcriptUrl === 'string' && requestProvenance.transcriptUrl.trim()
      ? requestProvenance.transcriptUrl.trim()
      : null;
  const contextResolutionMode =
    requestProvenance.contextResolution === 'branch_fallback' || requestProvenance.contextResolution === 'direct'
      ? requestProvenance.contextResolution
      : 'direct';
  const contextResolutionOriginalCheckpointId =
    typeof requestProvenance.contextResolutionOriginalCheckpointId === 'string' && requestProvenance.contextResolutionOriginalCheckpointId.trim()
      ? requestProvenance.contextResolutionOriginalCheckpointId.trim()
      : null;
  const contextResolutionResolvedCheckpointId =
    typeof requestProvenance.contextResolutionResolvedCheckpointId === 'string' && requestProvenance.contextResolutionResolvedCheckpointId.trim()
      ? requestProvenance.contextResolutionResolvedCheckpointId.trim()
      : null;
  const contextResolutionResolvedCommitSha =
    typeof requestProvenance.contextResolutionResolvedCommitSha === 'string' && requestProvenance.contextResolutionResolvedCommitSha.trim()
      ? requestProvenance.contextResolutionResolvedCommitSha.trim()
      : null;
  const contextResolutionResolvedCommitMessage =
    typeof requestProvenance.contextResolutionResolvedCommitMessage === 'string' && requestProvenance.contextResolutionResolvedCommitMessage.trim()
      ? requestProvenance.contextResolutionResolvedCommitMessage.trim()
      : null;
  const provenanceRepo = readOptionalString(requestProvenance.repo);
  const provenanceBranch = readOptionalString(requestProvenance.branch);
  if (!provenanceRepo || !provenanceBranch) {
    throw new Error('Review provenance must include repo and branch.');
  }
  const policyItems = extractPolicyItemsFromIntentContext(parseStringArray(requestProvenance.intentSessionContext));

  const report: ReviewReport = {
    summary,
    findings,
    summaryText: agentAnalysis?.summary,
    furtherPassesLowYield: agentAnalysis?.furtherPassesLowYield,
    intent,
    evidence,
    provenance: includeProvenance
      ? {
          repo: provenanceRepo,
          branch: provenanceBranch,
          sessionIds: parseStringArray(requestProvenance.sessionIds),
          policyItems,
          ...(rawSessionPrompts ? { rawSessionPrompts } : {}),
          ...(derivedIntentSummary ? { intentSummary: derivedIntentSummary } : {}),
          promptSummary,
          transcriptUrl,
          reviewContextRef: {
            id: reviewContext.id,
            r2Key: `review-context/${review.id}/${reviewContext.id}.json`,
          },
          reviewContextStats: {
            totalFilesIncluded: reviewContext.stats.totalFilesIncluded,
            totalBytesIncluded: reviewContext.stats.totalBytesIncluded,
            estimatedTokens: reviewContext.stats.estimatedTokens,
            tokenBudget: reviewContext.stats.tokenBudget,
          },
          coChange: {
            coChangeSkipped: reviewContext.retrieval.coChange.coChangeSkipped,
            coChangeSkipReason: reviewContext.retrieval.coChange.coChangeSkipReason,
            coChangeAvailable: reviewContext.retrieval.coChange.coChangeAvailable,
            relatedFileCount: reviewContext.retrieval.relatedFiles.length,
          },
          contextResolution:
            contextResolutionMode === 'branch_fallback' &&
            contextResolutionOriginalCheckpointId &&
            contextResolutionResolvedCheckpointId &&
            contextResolutionResolvedCommitSha
              ? {
                  contextResolution: 'branch_fallback',
                  originalCheckpointId: contextResolutionOriginalCheckpointId,
                  resolvedCheckpointId: contextResolutionResolvedCheckpointId,
                  resolvedCommitSha: contextResolutionResolvedCommitSha,
                  resolvedCommitMessage: contextResolutionResolvedCommitMessage,
                }
              : undefined,
          outputSchemaVersion: 'v2',
          passArchitecture: 'single',
          validation: agentAnalysis?.validation,
          furtherPassesLowYield:
            typeof agentAnalysis?.furtherPassesLowYield === 'boolean'
              ? {
                  value: agentAnalysis.furtherPassesLowYield,
                  source: 'model-self-assessment' as const,
                  reliability: 'weak-signal-phase2' as const,
                }
              : undefined,
          advisories: advisories.length > 0 ? advisories : undefined,
        }
      : {
          repo: provenanceRepo,
          branch: provenanceBranch,
          sessionIds: [],
          policyItems: [],
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
