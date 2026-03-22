import { strict as assert } from 'assert';
import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES_V2,
  validateAndNormalizeReviewAnalysisOutputV2,
} from './review-output-v2.js';

function basePayload(): any {
  return {
    findings: [
      {
        severity: 'medium',
        category: 'logic',
        passType: 'single',
        locations: [{ filePath: 'src/main.ts', startLine: 10, endLine: 12 }],
        description: 'Potential null access in request handling.',
        suggestedFix: 'Guard against null before dereferencing.',
        failingScenario: 'When request.auth is null and handler dereferences request.auth.userId.',
        evidence: 'src/main.ts:10-12 dereferences request.auth.userId without null guard.',
        guardGap: 'No preceding null check exists on request.auth in this code path.',
      },
    ],
    summary: 'One actionable finding found.',
    furtherPassesLowYield: true,
  };
}

export function runReviewOutputV2Tests(): void {
  for (const severity of REVIEW_FINDING_SEVERITIES_V2) {
    for (const category of REVIEW_FINDING_CATEGORIES) {
      const payload = basePayload();
      payload.findings[0].severity = severity;
      payload.findings[0].category = category;
      payload.findings[0].passType = 'single';
      const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
      assert.equal(result.ok, true);
    }
  }

  {
    const payload = basePayload();
    payload.findings[0].passType = 'security';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.passType')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].severity = 'urgent';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.severity')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].category = 'bug';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.category')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].passType = 'analysis';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.passType')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].locations = [
      { filePath: 'src/main.ts', startLine: 5, endLine: null },
    ] as Array<{ filePath: string; startLine: number | null; endLine: number | null }>;
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.includes('.locations[0]')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].locations = [{ filePath: 'src/main.ts', startLine: 20, endLine: 10 }];
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.message.includes('endLine must be greater than or equal')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].locations = [
      { filePath: 'src/main.ts', startLine: null, endLine: null },
    ] as Array<{ filePath: string; startLine: number | null; endLine: number | null }>;
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, true);
  }

  {
    const payload = basePayload();
    payload.findings[0].description = '   ';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.description')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].suggestedFix = '';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.suggestedFix')), true);
  }

  {
    const payload = basePayload();
    delete payload.findings[0].failingScenario;
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.failingScenario')), true);
  }

  {
    const payload = basePayload();
    payload.findings[0].evidence = '   ';
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.evidence')), true);
  }

  {
    const payload = basePayload();
    delete payload.findings[0].guardGap;
    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path.endsWith('.guardGap')), true);
  }

  {
    const payload = {
      findings: [
        {
          severity: 'high',
          category: 'security',
          passType: 'single',
          locations: [{ filePath: 'src\\auth.ts', startLine: 7, endLine: 7 }],
          description: '  Token leakage in logs.  ',
          suggestedFix: '  Redact token before logging.  ',
          failingScenario: '  Logging auth payload with token included in production path.  ',
          evidence: '  src/auth.ts:7 writes token field to logger.  ',
          guardGap: '  No redaction helper is invoked before log write.  ',
        },
        {
          severity: 'high',
          category: 'security',
          passType: 'single',
          locations: [{ filePath: 'src/auth.ts', startLine: 7, endLine: 7 }],
          description: 'Token leakage in logs.',
          suggestedFix: 'Redact token before logging.',
          failingScenario: 'Logging auth payload with token included in production path.',
          evidence: 'src/auth.ts:7 writes token field to logger.',
          guardGap: 'No redaction helper is invoked before log write.',
        },
        {
          severity: 'high',
          category: 'security',
          passType: 'single',
          locations: [{ filePath: 'src/auth.ts', startLine: 8, endLine: 8 }],
          description: 'Token leakage in logs.',
          suggestedFix: 'Redact token before logging.',
          failingScenario: 'Logging auth payload with token included in production path.',
          evidence: 'src/auth.ts:8 writes token field to logger.',
          guardGap: 'No redaction helper is invoked before log write.',
        },
      ],
      summary: '  Security issues found. ',
      furtherPassesLowYield: false,
    };

    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, 'Security issues found.');
    assert.equal(result.value.findings.length, 2);
    assert.equal(result.dedupedExactCount, 1);
    assert.equal(result.value.findings[0].locations[0]?.filePath, 'src/auth.ts');
  }

  {
    const payload = {
      findings: [],
      summary: { riskLevel: 'low', recommendation: 'approve' },
      summaryText: 'No actionable findings from legacy payload.',
    };

    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path === '$.summary'), true);
    assert.equal(result.errors.some((error) => error.path === '$.furtherPassesLowYield'), true);
  }

  {
    const payload = {
      findings: [],
      summary: 'No actionable findings.',
      furtherPassesLowYield: 'false',
    };

    const result = validateAndNormalizeReviewAnalysisOutputV2(payload);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.path === '$.furtherPassesLowYield'), true);
  }
}
