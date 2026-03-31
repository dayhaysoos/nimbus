import type { ReviewFinding } from '../../../types.js';

export async function replaceReviewFindings(
  db: D1Database,
  reviewId: string,
  findings: ReviewFinding[],
  options?: { startNumber?: number }
): Promise<void> {
  await db.prepare('DELETE FROM review_findings WHERE review_id = ?').bind(reviewId).run();

  const startNumber = typeof options?.startNumber === 'number' && Number.isFinite(options.startNumber) && options.startNumber > 0
    ? Math.floor(options.startNumber)
    : 1;

  for (const [index, finding] of findings.entries()) {
    const findingNumber = startNumber + index;
    const findingId = `${reviewId}_F-${String(findingNumber).padStart(3, '0')}`;
    await db
      .prepare(
        `INSERT INTO review_findings (id, review_id, severity, category, pass_type, description, locations_json, suggested_fix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        findingId,
        reviewId,
        finding.severity,
        finding.category,
        finding.passType,
        finding.description,
        JSON.stringify(finding.locations),
        finding.suggestedFix
      )
      .run();
  }
}

export async function getHighestFindingNumberForBranch(db: D1Database, repo: string, branch: string): Promise<number> {
  const normalizedRepo = repo.trim();
  const normalizedBranch = branch.trim();
  if (!normalizedRepo || !normalizedBranch) {
    return 0;
  }

  const row = await db
    .prepare(
      `SELECT
         COALESCE(MAX(
           CASE
             WHEN instr(rf.id, '_F-') > 0 THEN CAST(substr(rf.id, instr(rf.id, '_F-') + 3) AS INTEGER)
             ELSE 0
           END
         ), 0) AS max_seq
       FROM review_findings rf
       JOIN review_runs rr ON rr.id = rf.review_id
       WHERE rr.repo = ? AND rr.branch = ?`
    )
    .bind(normalizedRepo, normalizedBranch)
    .first<{ max_seq: number | null }>();

  const maxSeq = typeof row?.max_seq === 'number' && Number.isFinite(row.max_seq) ? row.max_seq : 0;
  return Math.max(0, Math.floor(maxSeq));
}
