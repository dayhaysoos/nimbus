import type {
  ReviewContext,
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewReport,
  ReviewRunResponse,
  ReviewSessionIntentSummary,
  ReviewSeverity,
} from '../../../types.js';
import type { ReviewAgentAnalysisResult } from '../../review-analysis.js';
import { buildEvidence, buildReviewMarkdown, deriveRecommendation, deriveRiskLevel, mergeFindings, sanitizeIntentBlock } from '../report.js';
import { parseStringArray } from '../context-helpers.js';
import { REVIEW_SEVERITY_RANK } from './shared.js';

export function buildDeploymentReportOutput(input: {
  review: ReviewRunResponse;
  reviewContext: ReviewContext;
  findingsFromAnalysis: ReviewFinding[];
  heuristicFindings: ReviewFinding[];
  severityThreshold: string;
  maxFindings: number;
  deployment: { deployedUrl: string | null };
  resultArtifact: Record<string, unknown>;
    includeValidationEvidence: boolean;
    includeMarkdownSummary: boolean;
    includeProvenance: boolean;
    derivedIntentSummary: ReviewSessionIntentSummary | null;
  promptGoal: string;
  promptConstraints: string[];
  promptDecisions: string[];
  requestProvenance: Record<string, unknown>;
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
  advisories: string[];
    agentAnalysis: ReviewAgentAnalysisResult | null;
    deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>;
}): ReviewReport {
  const severityFloor = REVIEW_SEVERITY_RANK[input.severityThreshold as ReviewSeverity] ?? REVIEW_SEVERITY_RANK.low;
  const mergedFindings = mergeFindings(input.findingsFromAnalysis, input.heuristicFindings)
    .filter((finding) => REVIEW_SEVERITY_RANK[finding.severity] >= severityFloor)
    .sort((left, right) => REVIEW_SEVERITY_RANK[right.severity] - REVIEW_SEVERITY_RANK[left.severity])
    .slice(0, input.maxFindings);

  const agentEvidence: ReviewEvidenceItem | null = input.agentAnalysis
    ? {
        id: 'ev_review_agent',
        type: 'analysis_agent',
        label: `AI review analysis via ${input.agentAnalysis.provider}`,
        status: 'info',
        metadata: {
          model: input.agentAnalysis.model,
          stepsExecuted: input.agentAnalysis.stepsExecuted,
          usedTools: input.agentAnalysis.usedTools,
        },
      }
    : null;

  const evidence = buildEvidence(
    input.deploymentEvents,
    input.deployment,
    input.resultArtifact,
    input.includeValidationEvidence,
    agentEvidence
  );
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
    goal: input.agentAnalysis?.intent?.goal ?? input.promptGoal,
    constraints: Array.from(new Set([...(input.agentAnalysis?.intent?.constraints ?? []), ...input.promptConstraints])),
    decisions: Array.from(new Set([...(input.agentAnalysis?.intent?.decisions ?? []), ...input.promptDecisions])),
  });

  const report: ReviewReport = {
    summary,
    findings,
    summaryText: input.agentAnalysis?.summary,
    furtherPassesLowYield: input.agentAnalysis?.furtherPassesLowYield,
    intent,
    evidence,
    provenance: input.includeProvenance
      ? {
          repo: input.provenanceRepo,
          branch: input.provenanceBranch,
          sessionIds: parseStringArray(input.requestProvenance.sessionIds),
          policyItems: input.policyItems,
          ...(input.rawSessionPrompts ? { rawSessionPrompts: input.rawSessionPrompts } : {}),
          ...(input.derivedIntentSummary ? { intentSummary: input.derivedIntentSummary } : {}),
          promptSummary: input.promptSummary,
          transcriptUrl: input.transcriptUrl,
          reviewContextRef: {
            id: input.reviewContext.id,
            r2Key: `review-context/${input.review.id}/${input.reviewContext.id}.json`,
          },
          reviewContextStats: {
            totalFilesIncluded: input.reviewContext.stats.totalFilesIncluded,
            totalBytesIncluded: input.reviewContext.stats.totalBytesIncluded,
            estimatedTokens: input.reviewContext.stats.estimatedTokens,
            tokenBudget: input.reviewContext.stats.tokenBudget,
          },
          coChange: {
            coChangeSkipped: input.reviewContext.retrieval.coChange.coChangeSkipped,
            coChangeSkipReason: input.reviewContext.retrieval.coChange.coChangeSkipReason,
            coChangeAvailable: input.reviewContext.retrieval.coChange.coChangeAvailable,
            relatedFileCount: input.reviewContext.retrieval.relatedFiles.length,
          },
          contextResolution:
            input.contextResolutionMode === 'branch_fallback' &&
            input.contextResolutionOriginalCheckpointId &&
            input.contextResolutionResolvedCheckpointId &&
            input.contextResolutionResolvedCommitSha
              ? {
                  contextResolution: 'branch_fallback',
                  originalCheckpointId: input.contextResolutionOriginalCheckpointId,
                  resolvedCheckpointId: input.contextResolutionResolvedCheckpointId,
                  resolvedCommitSha: input.contextResolutionResolvedCommitSha,
                  resolvedCommitMessage: input.contextResolutionResolvedCommitMessage,
                }
              : undefined,
          outputSchemaVersion: 'v2',
          passArchitecture: 'single',
          validation: input.agentAnalysis?.validation,
          furtherPassesLowYield:
            typeof input.agentAnalysis?.furtherPassesLowYield === 'boolean'
              ? {
                  value: input.agentAnalysis.furtherPassesLowYield,
                  source: 'model-self-assessment' as const,
                  reliability: 'weak-signal-phase2' as const,
                }
              : undefined,
          advisories: input.advisories.length > 0 ? input.advisories : undefined,
        }
      : {
          repo: input.provenanceRepo,
          branch: input.provenanceBranch,
          sessionIds: [],
          policyItems: [],
          promptSummary: null,
          transcriptUrl: null,
        },
    markdownSummary: null,
  };

  if (input.includeMarkdownSummary) {
    report.markdownSummary = buildReviewMarkdown(report);
  }

  return report;
}
