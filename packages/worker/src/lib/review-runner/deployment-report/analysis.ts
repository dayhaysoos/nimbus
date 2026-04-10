import type { Env, ReviewContext, ReviewRunResponse } from '../../../types.js';
import { appendReviewEvent, getWorkspaceDeployment, getWorkspaceDeploymentRequestPayload } from '../../db.js';
import { runWorkspaceDeploymentAgentAnalysis } from '../../review-analysis.js';
import { asRecord, readOptionalString, resolveReviewAnalysisModel } from '../context-helpers.js';
import { loadAuthoritativeDeploymentDiff } from '../context-diff.js';
import { buildEvidence, buildHeuristicFindings } from '../report.js';
import type { ReviewRunExecutionOptions } from '../shared.js';
import { DEFAULT_REVIEW_ANALYSIS_TIMEOUT_MS, parseTimeoutMs, withTimeout } from './shared.js';

/**
 * Runs the optional model-backed analysis pass and returns agent output plus heuristic inputs.
 */
export async function runDeploymentReviewAnalysisStage(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  reviewContext: ReviewContext,
  inputs: {
    requestValidation: Record<string, unknown>;
    resultProvenance: Record<string, unknown>;
    resultArtifact: Record<string, unknown>;
    intentSessionContext: string[];
    derivedIntentSummary: unknown;
    promptGoal: string;
    promptConstraints: string[];
    promptDecisions: string[];
  },
  options?: ReviewRunExecutionOptions
) {
  const deployment = await getWorkspaceDeployment(env.DB, review.workspaceId, review.deploymentId);
  if (!deployment) {
    throw new Error(`Deployment not found for review target ${review.deploymentId}`);
  }

  const deploymentRequest = (await getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId)) ?? {};
  const deploymentEvents = await import('../../db.js').then((m) => m.listWorkspaceDeploymentEvents(env.DB, review.workspaceId, review.deploymentId, 0, 500));
  const heuristicFindings = buildHeuristicFindings(review, deploymentEvents);
  const analysisEvidence = buildEvidence(deploymentEvents, deployment, inputs.resultArtifact, true);
  const provenanceOperationId = typeof inputs.resultProvenance.operationId === 'string' ? inputs.resultProvenance.operationId : null;
  const reviewDiffArtifactId = typeof inputs.resultArtifact.reviewDiffArtifactId === 'string'
    ? inputs.resultArtifact.reviewDiffArtifactId
    : typeof inputs.resultProvenance.reviewDiffArtifactId === 'string'
      ? inputs.resultProvenance.reviewDiffArtifactId
      : null;
  const authoritativeDiff = await loadAuthoritativeDeploymentDiff(env, review.workspaceId, provenanceOperationId, reviewDiffArtifactId);
  const reviewAnalysisModel = resolveReviewAnalysisModel(payload, env);
  let agentAnalysis: Awaited<ReturnType<typeof runWorkspaceDeploymentAgentAnalysis>> = null;
  const requestOpenrouterApiKey = readOptionalString(options?.openrouterApiKey);
  const reviewAgentEnabled = Boolean((env.AGENT_SDK_URL ?? '').trim()) || Boolean((requestOpenrouterApiKey ?? env.OPENROUTER_API_KEY ?? '').trim());
  const reviewAnalysisProvider = (requestOpenrouterApiKey ?? env.OPENROUTER_API_KEY ?? '').trim() ? 'openrouter' : 'cloudflare_agents_sdk';
  const deploymentSourceBundleKey =
    typeof inputs.resultArtifact.sourceBundleKey === 'string' && inputs.resultArtifact.sourceBundleKey.trim()
      ? inputs.resultArtifact.sourceBundleKey.trim()
      : deployment.sourceBundleKey ?? null;

  if (reviewAgentEnabled && deploymentSourceBundleKey) {
    await appendReviewEvent(env.DB, {
      reviewId: review.id,
      eventType: 'review_analysis_agent_started',
      payload: { provider: reviewAnalysisProvider, model: reviewAnalysisModel },
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
            ? { source: authoritativeDiff.source, artifactId: authoritativeDiff.artifactId, patch: authoritativeDiff.patch }
            : undefined,
          goal: inputs.promptGoal,
          constraints: inputs.promptConstraints,
          decisions: inputs.promptDecisions.filter(Boolean),
          intentSessionContext: inputs.intentSessionContext,
          intentSummary: inputs.derivedIntentSummary as never,
          evidenceCatalog: analysisEvidence.map((item) => ({ id: item.id, type: item.type, label: item.label, status: item.status })),
          deploymentSummary: {
            provider: deployment.provider,
            deployedUrl: deployment.deployedUrl,
            validationSummary: JSON.stringify(inputs.requestValidation),
          },
          abortSignal: options?.abortSignal,
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
            openrouterApiKey: requestOpenrouterApiKey,
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
          payload: { timeoutMs: analysisTimeoutMs, message },
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

  return { deployment, deploymentRequest, deploymentEvents, heuristicFindings, analysisEvidence, agentAnalysis };
}
