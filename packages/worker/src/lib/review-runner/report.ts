import type {
  ReviewEvidenceItem,
  ReviewFinding,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunResponse,
  ReviewSeverity,
} from '../../types.js';
import { redactReviewText } from '../review-redaction.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

/** Builds the final markdown summary shown and exported for a review report. */
export function buildReviewMarkdown(report: ReviewReport): string {
  const evidenceLines = report.evidence.map((item) => `${item.label} (${item.status})`);
  const provenanceLines: string[] = [];
  if (report.provenance.promptSummary) {
    provenanceLines.push(report.provenance.promptSummary);
  }
  if (report.provenance.sessionIds.length > 0) {
    provenanceLines.push(`Sessions: ${report.provenance.sessionIds.join(', ')}`);
  }
  if (report.provenance.contextResolution?.contextResolution === 'branch_fallback') {
    provenanceLines.push(
      `Context resolution: branch fallback from checkpoint ${report.provenance.contextResolution.originalCheckpointId} to ${report.provenance.contextResolution.resolvedCheckpointId} (${report.provenance.contextResolution.resolvedCommitSha.slice(0, 12)}).`
    );
  }
  if (report.provenance.coChange) {
    if (report.provenance.coChange.coChangeSkipped) {
      provenanceLines.push(
        `Co-change context skipped (${report.provenance.coChange.coChangeSkipReason ?? 'unknown_reason'}). Baseline review only; provide X-Review-Github-Token (CLI: set REVIEW_CONTEXT_GITHUB_TOKEN) for full quality review context.`
      );
    } else if (report.provenance.coChange.coChangeAvailable) {
      provenanceLines.push(`Co-change context included (${report.provenance.coChange.relatedFileCount} related files).`);
    } else {
      provenanceLines.push('Co-change lookup ran successfully and found no related files.');
    }
  }
  if (Array.isArray(report.provenance.advisories) && report.provenance.advisories.length > 0) {
    provenanceLines.push(...report.provenance.advisories);
  }

  const findingLines =
    report.findings.length === 0
      ? ['No actionable findings were emitted for this deployment review.']
      : report.findings.map((finding) => {
          const location = finding.locations[0]
            ? finding.locations[0].startLine !== null && finding.locations[0].endLine !== null
              ? `${finding.locations[0].filePath}:${finding.locations[0].startLine}-${finding.locations[0].endLine}`
              : finding.locations[0].filePath
            : 'deployment-level';
          return `[${finding.severity}/${finding.category}/${finding.passType}] ${finding.description} (${location})`;
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

export function mergeFindings(primary: ReviewFinding[], secondary: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const merged: ReviewFinding[] = [];

  for (const finding of [...primary, ...secondary]) {
    const key = JSON.stringify(finding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(finding);
  }

  return merged;
}

/**
 * Synthesizes low-cost findings from deployment events when validation/runtime signals imply a likely issue
 * even if the agent analysis did not emit a structured finding.
 */
export function buildHeuristicFindings(
  _review: ReviewRunResponse,
  deploymentEvents: Array<{ eventType: string; payload: unknown; seq: number }>
): ReviewFinding[] {
  return deploymentEvents.flatMap<ReviewFinding>((event) => {
    const eventPayload = asRecord(event.payload);
    if (event.eventType === 'deployment_validation_tool_missing') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          severity: 'medium',
          category: 'logic',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description:
            typeof eventPayload.message === 'string'
              ? eventPayload.message
              : `Validation tool missing for ${step} in runtime.`,
          suggestedFix: `Install the required ${step} validation tool in the deployment runtime or disable that validation step explicitly.`,
        },
      ];
    }
    if (event.eventType === 'validation_skipped') {
      const step = typeof eventPayload.step === 'string' ? eventPayload.step : 'validation';
      return [
        {
          severity: 'low',
          category: 'style',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description: `Nimbus skipped ${step} validation while preparing this deployment review.`,
          suggestedFix: `Run the ${step} validation in the deployment path or document why it is intentionally skipped.`,
        },
      ];
    }
    if (event.eventType === 'deployment_toolchain_unknown_fallback') {
      return [
        {
          severity: 'low',
          category: 'style',
          passType: 'single',
          locations: [{ filePath: 'deployment', startLine: null, endLine: null }],
          description: 'Deployment completed after a toolchain fallback, which may hide package-manager-specific issues.',
          suggestedFix: 'Declare an explicit package manager and lockfile so future deploys and reviews use deterministic tooling.',
        },
      ];
    }
    return [];
  });
}

export function buildEvidence(
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

export function deriveRiskLevel(findings: ReviewFinding[], fallback: ReviewSeverity = 'low'): ReviewSeverity {
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

export function deriveRecommendation(findings: ReviewFinding[]): ReviewRecommendation {
  const riskLevel = deriveRiskLevel(findings);
  if (riskLevel === 'critical' || riskLevel === 'high') {
    return 'request_changes';
  }
  if (riskLevel === 'medium' || riskLevel === 'low') {
    return findings.length > 0 ? 'comment' : 'approve';
  }
  return 'approve';
}

export function sanitizeIntentBlock(intent: {
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
