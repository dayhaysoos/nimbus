import type { ReviewSessionOutcomeSummary, ReviewSessionResponse } from '../../lib/types.js';

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatEvidenceSummary(outcome: ReviewSessionOutcomeSummary): string {
  return [
    pluralize(outcome.evidence.passed, 'passed check'),
    pluralize(outcome.evidence.warning, 'warning'),
    pluralize(outcome.evidence.failed, 'failed check'),
    pluralize(outcome.evidence.info, 'info item'),
  ].join(', ');
}

function formatChangeSummary(outcome: ReviewSessionOutcomeSummary): string {
  if (!outcome.changes.applied && outcome.changes.changedFileCount === 0) {
    return 'no Nimbus-authored code changes';
  }

  const parts: string[] = [];
  if (outcome.changes.applied) {
    parts.push(`${pluralize(outcome.changes.remediationCount, 'remediation pass')} applied`);
  }
  parts.push(pluralize(outcome.changes.changedFileCount, 'changed file'));
  return parts.join(', ');
}

function formatUnresolvedSummary(outcome: ReviewSessionOutcomeSummary): string {
  if (outcome.unresolved.findingCount === 0) {
    return '0 remaining findings';
  }

  const severity = outcome.unresolved.highestSeverity ? `, highest ${outcome.unresolved.highestSeverity}` : '';
  return `${pluralize(outcome.unresolved.findingCount, 'remaining finding')}${severity}`;
}

function printIndentedDetail(label: string, value: string, indent: string): void {
  console.log(`${indent}${label.padEnd(16, ' ')}${value}`);
}

export function printReviewSessionOutcome(
  session: ReviewSessionResponse,
  options?: { indent?: string; detailed?: boolean; heading?: string | null }
): void {
  const outcome = session.outcome;
  if (!outcome) {
    return;
  }

  const indent = options?.indent ?? '  ';
  const detailIndent = `${indent}  `;
  const heading = options?.heading ?? 'Session Outcome:';

  console.log('');
  if (heading) {
    console.log(`${indent}${heading}`);
  }

  printIndentedDetail('Outcome:', outcome.kind, detailIndent);
  printIndentedDetail('Summary:', outcome.summary ?? 'none', detailIndent);
  printIndentedDetail('Residual Risk:', outcome.residualRisk ?? 'none', detailIndent);
  printIndentedDetail('Recommendation:', outcome.recommendation ?? 'none', detailIndent);
  printIndentedDetail('Context Mode:', outcome.reviewed.contextMode ?? 'unknown', detailIndent);
  printIndentedDetail('Changes:', formatChangeSummary(outcome), detailIndent);
  printIndentedDetail('Evidence:', formatEvidenceSummary(outcome), detailIndent);
  printIndentedDetail('Unresolved:', formatUnresolvedSummary(outcome), detailIndent);
  printIndentedDetail('Adopt:', outcome.materializeReady ? 'ready' : 'not ready', detailIndent);

  if (outcome.materializeReady) {
    printIndentedDetail('Next Action:', `nimbus review session adopt ${session.id}`, detailIndent);
  }

  if (!options?.detailed) {
    return;
  }

  for (const summary of outcome.changes.summaries) {
    printIndentedDetail('Applied Fix:', summary, detailIndent);
  }

  for (const finding of outcome.unresolved.highlights) {
    const location = finding.filePath ? ` (${finding.filePath})` : '';
    printIndentedDetail(
      'Remaining:',
      `${finding.severity} ${finding.category}: ${finding.description}${location}`,
      detailIndent
    );
  }
}
