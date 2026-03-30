import { parseJsonOrFallback, ReviewEventItem, ReviewEventRecord, stripSensitiveTokenFields } from './shared.js';

export async function appendReviewEvent(
  db: D1Database,
  input: { reviewId: string; eventType: string; payload: unknown }
): Promise<number> {
  const seqResult = await db
    .prepare('UPDATE review_runs SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq')
    .bind(input.reviewId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for review run ${input.reviewId}`);
  }

  const seq = Number(seqResult.last_event_seq);
  await db
    .prepare(`INSERT INTO review_events (review_id, seq, event_type, payload_json) VALUES (?, ?, ?, ?)`)
    .bind(input.reviewId, seq, input.eventType, JSON.stringify(stripSensitiveTokenFields(input.payload)))
    .run();

  return seq;
}

export async function listReviewEvents(
  db: D1Database,
  reviewId: string,
  fromExclusive = 0,
  limit = 500
): Promise<ReviewEventItem[]> {
  const result = await db
    .prepare(`SELECT seq, event_type, payload_json, created_at FROM review_events WHERE review_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .bind(reviewId, fromExclusive, limit)
    .all<ReviewEventRecord>();

  return result.results.map((row) => ({
    seq: row.seq,
    eventType: row.event_type,
    payload: parseJsonOrFallback(row.payload_json, { raw: row.payload_json }),
    createdAt: row.created_at,
  }));
}

export async function hasReviewEvent(db: D1Database, reviewId: string, eventType: string): Promise<boolean> {
  const record = await db
    .prepare(`SELECT 1 FROM review_events WHERE review_id = ? AND event_type = ? LIMIT 1`)
    .bind(reviewId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}
