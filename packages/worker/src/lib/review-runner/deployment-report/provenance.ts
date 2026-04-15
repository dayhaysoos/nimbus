import type { Env, ReviewRunResponse } from '../../../types.js';
import { getWorkspaceTask } from '../../db.js';
import { extractPolicyItemsFromIntentContext, redactReviewText } from '../../review-redaction.js';
import { intentSummaryFromApprovedPolicy, summarizeReviewIntentPolicy } from '../intent-summary.js';
import { asRecord, mergeProvenance, parseStringArray, readOptionalString, uniqueStrings } from '../context-helpers.js';
import { ReviewContextAssemblyError } from '../cochange.js';
import { LARGE_DIFF_ADVISORY_THRESHOLD, parseBoolean, parsePositiveInteger } from './shared.js';

function formatFindingMemoryEntry(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.description !== 'string' || !entry.description.trim()) {
    return null;
  }
  const filePath = typeof entry.filePath === 'string' && entry.filePath.trim() ? entry.filePath.trim() : null;
  const startLine =
    typeof entry.startLine === 'number' && Number.isFinite(entry.startLine) && entry.startLine > 0
      ? Math.floor(entry.startLine)
      : null;
  return `${entry.description.trim()}${filePath ? ` (${filePath}${startLine ? `:${startLine}` : ''})` : ''}`;
}

function readFindingMemoryList(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => formatFindingMemoryEntry(entry)).filter((entry): entry is string => Boolean(entry)).slice(0, limit);
}

/**
 * Collects provenance, policy, and prompt-history inputs needed to build a deployment review report.
 */
export async function buildDeploymentReportInputs(
  env: Env,
  review: ReviewRunResponse,
  payload: Record<string, unknown>,
  deploymentRequest: Record<string, unknown>,
  deploymentResult: Record<string, unknown>,
  reviewContextFilesConsidered: number,
  openrouterApiKey?: string | null
): Promise<{
  reviewPolicy: Record<string, unknown>;
  reviewFormat: Record<string, unknown>;
  requestValidation: Record<string, unknown>;
  requestProvenance: Record<string, unknown>;
  resultProvenance: Record<string, unknown>;
  resultArtifact: Record<string, unknown>;
  intentSessionContext: string[];
  derivedIntentSummary: Awaited<ReturnType<typeof summarizeReviewIntentPolicy>>;
  provenanceTask: Awaited<ReturnType<typeof getWorkspaceTask>>;
  taskResult: Record<string, unknown>;
  severityThreshold: string;
  maxFindings: number;
  includeProvenance: boolean;
  includeValidationEvidence: boolean;
  includeMarkdownSummary: boolean;
  advisories: string[];
  promptGoal: string;
  promptConstraints: string[];
  promptDecisions: string[];
  provenanceRepo: string;
  provenanceBranch: string;
  policyItems: string[];
  rawSessionPrompts: string | null;
  promptSummary: string | null;
  transcriptUrl: string | null;
  contextResolutionMode: string;
  contextResolutionOriginalCheckpointId: string | null;
  contextResolutionResolvedCheckpointId: string | null;
  contextResolutionResolvedCommitSha: string | null;
  contextResolutionResolvedCommitMessage: string | null;
  reviewContextMode: 'intent_aware' | 'basic';
}> {
  const reviewPolicy = asRecord(payload.policy);
  const reviewFormat = asRecord(payload.format);
  const resultProvenance = asRecord(deploymentResult.provenance);
  const resultArtifact = asRecord(deploymentResult.artifact);
  const requestValidation = asRecord(deploymentRequest.validation);
  const requestProvenance = mergeProvenance(asRecord(deploymentRequest.provenance), asRecord(payload.provenance));
  const intentSessionContext = uniqueStrings(parseStringArray(requestProvenance.intentSessionContext)).slice(0, 8);
  const approvedPolicy = review.approvedPolicy ?? null;
  const rawSessionPromptsFromProvenance =
    typeof requestProvenance.rawSessionPrompts === 'string' && requestProvenance.rawSessionPrompts.trim()
      ? requestProvenance.rawSessionPrompts.trim()
      : null;
  const rawSessionPrompts = rawSessionPromptsFromProvenance ?? (intentSessionContext.length > 0 ? intentSessionContext.join('\n') : null);
  const sessionIds = uniqueStrings(parseStringArray(requestProvenance.sessionIds));
  const reviewContextMode =
    requestProvenance.reviewContextMode === 'basic'
      ? 'basic'
      : requestProvenance.reviewContextMode === 'intent_aware'
        ? 'intent_aware'
        : sessionIds.length > 0 || intentSessionContext.length > 0 || Boolean(rawSessionPrompts)
          ? 'intent_aware'
          : 'basic';
  const intentSummaryModel = readOptionalString(requestProvenance.intentSummaryModel);
  if (reviewContextMode === 'intent_aware' && !approvedPolicy && !rawSessionPrompts) {
    throw new ReviewContextAssemblyError(
      'review_context_prompt_history_missing',
      'Review prompt-history context is required for intent summarization. Ensure deployment/review provenance includes rawSessionPrompts.'
    );
  }

  const derivedIntentSummary = approvedPolicy
    ? intentSummaryFromApprovedPolicy(approvedPolicy)
    : rawSessionPrompts
      ? await summarizeReviewIntentPolicy(env, {
          rawSessionPrompts: rawSessionPrompts ?? '',
          intentSessionContext,
          openrouterApiKey: readOptionalString(openrouterApiKey),
          intentSummaryModel,
        })
      : null;

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
  const advisories =
    reviewContextFilesConsidered > LARGE_DIFF_ADVISORY_THRESHOLD
      ? [`Large diff detected (${reviewContextFilesConsidered} files). Consider smaller, focused commits for higher quality reviews.`]
      : [];
  const reviewBasis = payload.reviewBasis === 'environment' ? 'environment' : 'checkpoint';
  const sessionFindingMemory = asRecord(requestProvenance.sessionFindingMemory);
  const remediationTargetSummaries = readFindingMemoryList(sessionFindingMemory.remediationTargets, 6);
  const repeatedTargetSummaries = readFindingMemoryList(sessionFindingMemory.repeatedTargets, 4);
  const previouslyResolvedSummaries = readFindingMemoryList(sessionFindingMemory.previouslyResolvedFindings, 4);
  const hasRemediationFindingMemory = remediationTargetSummaries.length > 0;

  const baseGoal =
    typeof provenanceTask?.prompt === 'string' && provenanceTask.prompt.trim()
      ? provenanceTask.prompt.trim()
      : typeof requestProvenance.note === 'string' && requestProvenance.note.trim()
        ? requestProvenance.note.trim()
        : reviewBasis === 'environment'
          ? hasRemediationFindingMemory
            ? `Verify whether the latest remediation for session ${review.sessionId ?? 'unknown'} actually resolved the targeted findings in the current workspace state.`
            : `Assess the current mutable workspace state for session ${review.sessionId ?? 'unknown'} against the anchor deployment ${review.deploymentId}.`
          : reviewContextMode === 'basic'
            ? `Assess workspace deployment ${review.deploymentId} for correctness and regressions using the diff, changed files, and repository conventions only.`
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
    reviewContextMode === 'basic'
      ? 'Entire intent context was unavailable for this review; product intent must not be inferred beyond code and validation evidence.'
      : 'Entire intent context was available for this review.',
    hasRemediationFindingMemory
      ? 'This is a remediation follow-up review. Treat targeted findings as verification targets; do not restate them as novel unless they are still present in the remediated workspace.'
      : '',
    previouslyResolvedSummaries.length > 0
      ? 'Earlier session findings were already resolved in prior passes. Only mention them again if the current workspace truly reintroduced them.'
      : '',
  ];
  const baseDecisions = [
    reviewBasis === 'environment'
      ? 'Review basis: current workspace environment state.'
      : 'Review basis: anchor checkpoint/deployment snapshot.',
    typeof resultProvenance.trigger === 'string'
      ? `Deployment trigger: ${resultProvenance.trigger}.`
      : typeof requestProvenance.trigger === 'string'
        ? `Deployment trigger: ${requestProvenance.trigger}.`
        : 'Deployment trigger was not recorded.',
    provenanceTask ? `Source task model: ${provenanceTask.model}.` : '',
    typeof taskResult.summary === 'string' && taskResult.summary.trim() ? `Source task summary: ${taskResult.summary.trim()}.` : '',
    parseStringArray(requestProvenance.sessionIds).length > 0
      ? `Related Entire sessions: ${parseStringArray(requestProvenance.sessionIds).join(', ')}.`
      : '',
    intentSessionContext.length > 0 ? `Prompt-history context excerpts provided: ${intentSessionContext.length}.` : '',
    reviewContextMode === 'basic' ? 'Review context mode: basic code-aware review.' : 'Review context mode: Entire intent-aware review.',
    hasRemediationFindingMemory
      ? `Remediation verification targets: ${remediationTargetSummaries.join('; ')}.`
      : '',
    repeatedTargetSummaries.length > 0
      ? `Persistent targets from earlier passes: ${repeatedTargetSummaries.join('; ')}.`
      : '',
    previouslyResolvedSummaries.length > 0
      ? `Previously resolved session findings: ${previouslyResolvedSummaries.join('; ')}.`
      : '',
    hasRemediationFindingMemory
      ? 'If a targeted finding remains, call it out as persisting after remediation. If it disappeared, treat that as resolved and focus on any remaining or new issues.'
      : '',
  ];
  const promptGoal = approvedPolicy?.goal?.trim() || provenanceTask?.prompt?.trim() || baseGoal;
  const promptConstraints = approvedPolicy ? Array.from(new Set([...approvedPolicy.constraints, ...baseConstraints])) : baseConstraints;
  const promptDecisions = approvedPolicy
    ? Array.from(new Set([...approvedPolicy.prohibitions.map((item) => `Must not: ${item}`), ...baseDecisions]))
    : baseDecisions;

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
  const promptSummary = redactReviewText(
    (typeof requestProvenance.note === 'string' ? requestProvenance.note.trim() : null) ||
      `Review generated in ${review.mode} mode for deployment ${review.deploymentId}.`
  );

  return {
    reviewPolicy,
    reviewFormat,
    requestValidation,
    requestProvenance,
    resultProvenance,
    resultArtifact,
    intentSessionContext,
    derivedIntentSummary,
    provenanceTask,
    taskResult,
    severityThreshold,
    maxFindings,
    includeProvenance,
    includeValidationEvidence,
    includeMarkdownSummary,
    advisories,
    promptGoal,
    promptConstraints,
    promptDecisions,
    provenanceRepo,
    provenanceBranch,
    policyItems,
    rawSessionPrompts,
    promptSummary,
    transcriptUrl,
    contextResolutionMode,
    contextResolutionOriginalCheckpointId,
    contextResolutionResolvedCheckpointId,
    contextResolutionResolvedCommitSha,
    contextResolutionResolvedCommitMessage,
    reviewContextMode,
  };
}
