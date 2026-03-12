import { strict as assert } from 'assert';
import { parseReviewMaxFindings, parseReviewSeverityThreshold } from './review-policy.js';

export async function runReviewPolicyTests(): Promise<void> {
  assert.equal(parseReviewSeverityThreshold(undefined), undefined);
  assert.equal(parseReviewSeverityThreshold('medium'), 'medium');
  assert.throws(() => parseReviewSeverityThreshold('typo'), /Invalid --severity-threshold/);

  assert.equal(parseReviewMaxFindings(undefined), undefined);
  assert.equal(parseReviewMaxFindings('12'), 12);
  assert.throws(() => parseReviewMaxFindings('12abc'), /Invalid --max-findings/);
  assert.throws(() => parseReviewMaxFindings('abc'), /Invalid --max-findings/);
  assert.throws(() => parseReviewMaxFindings('0'), /Invalid --max-findings/);
}
