import type { BuildMetrics } from './types.js';
import { formatDuration, formatCost, formatNumber } from './report.js';

/**
 * Print the build summary box to the terminal
 */
export function printSummary(metrics: BuildMetrics): void {
  const line = '-------------------------------------------';
  const urlLabel = metrics.deploySuccess ? 'URL:' : 'Preview:';
  const urlNote = metrics.deploySuccess ? '' : ' (temporary - deploy failed)';

  console.log('');
  console.log(line);
  console.log('  Summary');
  console.log(line);
  console.log(`  ${urlLabel.padEnd(10)} ${metrics.deployedUrl}${urlNote}`);
  console.log(line);
  console.log(`  Model:       ${metrics.model}`);
  console.log(
    `  Tokens:      ${formatNumber(metrics.totalTokens)} (in: ${formatNumber(metrics.promptTokens)} / out: ${formatNumber(metrics.completionTokens)})`
  );
  console.log(`  Cost:        ${formatCost(metrics.cost)}`);
  console.log(`  Duration:    ${formatDuration(metrics.totalDurationMs)}`);
  console.log(`  Files:       ${metrics.filesGenerated}`);
  console.log(`  LoC:         ${formatNumber(metrics.linesOfCode)}`);
  console.log(line);
}
