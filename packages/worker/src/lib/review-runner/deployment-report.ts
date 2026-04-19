import type { Env, ReviewContext, ReviewReport, ReviewRunResponse, ReviewSeverity } from '../../types.js';
import { getWorkspaceDeployment } from '../db.js';
import { readOptionalString, asRecord } from './context-helpers.js';
import type { ReviewRunExecutionOptions } from './shared.js';
import { runDeploymentReviewAnalysisStage } from './deployment-report/analysis.js';
import { buildDeploymentReportOutput } from './deployment-report/output.js';
import { buildDeploymentReportInputs } from './deployment-report/provenance.js';
import { REVIEW_SEVERITY_RANK } from './deployment-report/shared.js';

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
  const result = asRecord(deployment.result);
  const inputs = await buildDeploymentReportInputs(
    env,
    review,
    payload,
    (await import('../db.js').then((m) => m.getWorkspaceDeploymentRequestPayload(env.DB, review.deploymentId))) ?? {},
    result,
    reviewContext.retrieval.coChange.filesConsidered,
    readOptionalString(options?.providerApiKey),
    readOptionalString(options?.openrouterApiKey)
  );
  const analysisStage = await runDeploymentReviewAnalysisStage(env, review, payload, reviewContext, {
    requestValidation: inputs.requestValidation,
    resultProvenance: inputs.resultProvenance,
    resultArtifact: inputs.resultArtifact,
    intentSessionContext: inputs.intentSessionContext,
    derivedIntentSummary: inputs.derivedIntentSummary,
    promptGoal: inputs.promptGoal,
    promptConstraints: inputs.promptConstraints,
    promptDecisions: inputs.promptDecisions,
  }, options);
  const { deploymentEvents, heuristicFindings, analysisEvidence, agentAnalysis } = analysisStage;

  return buildDeploymentReportOutput({
    review,
    reviewContext,
    findingsFromAnalysis: agentAnalysis?.findings ?? [],
    heuristicFindings,
    severityThreshold: inputs.severityThreshold,
    maxFindings: inputs.maxFindings,
    deployment,
    resultArtifact: inputs.resultArtifact,
    includeValidationEvidence: inputs.includeValidationEvidence,
    includeMarkdownSummary: inputs.includeMarkdownSummary,
    includeProvenance: inputs.includeProvenance,
    derivedIntentSummary: inputs.derivedIntentSummary,
    promptGoal: inputs.promptGoal,
    promptConstraints: inputs.promptConstraints,
    promptDecisions: inputs.promptDecisions,
    requestProvenance: inputs.requestProvenance,
    provenanceRepo: inputs.provenanceRepo,
    provenanceBranch: inputs.provenanceBranch,
    policyItems: inputs.policyItems,
    rawSessionPrompts: inputs.rawSessionPrompts,
    promptSummary: inputs.promptSummary,
    transcriptUrl: inputs.transcriptUrl,
    contextResolutionMode: inputs.contextResolutionMode,
    contextResolutionOriginalCheckpointId: inputs.contextResolutionOriginalCheckpointId,
    contextResolutionResolvedCheckpointId: inputs.contextResolutionResolvedCheckpointId,
    contextResolutionResolvedCommitSha: inputs.contextResolutionResolvedCommitSha,
    contextResolutionResolvedCommitMessage: inputs.contextResolutionResolvedCommitMessage,
    reviewContextMode: inputs.reviewContextMode,
    advisories: inputs.advisories,
    agentAnalysis,
    deploymentEvents,
  });
}
