import type {
  ReviewBasis,
  ReviewCreateResponse,
  ReviewEventEnvelope,
  ReviewGetResponse,
  ReviewPolicyApproveResponse,
  ReviewPolicyDeriveResponse,
  ReviewPolicyMode,
  ReviewPolicyResponse,
} from '../../lib/types.js';
import { throwWorkerError, withReviewHeaders, workerFetch } from './shared.js';

export async function createReview(
  workerUrl: string,
  idempotencyKey: string,
  payload: {
    target: {
      type: 'workspace_deployment';
      workspaceId: string;
      deploymentId: string;
    };
    mode: 'report_only';
    policyMode?: ReviewPolicyMode;
    reviewBasis?: ReviewBasis;
    policy?: {
      severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
      maxFindings?: number;
      includeProvenance?: boolean;
      includeValidationEvidence?: boolean;
    };
    model?: string;
    provenance: {
      note?: string | null;
      repo: string;
      branch: string;
      intentSummaryModel?: string;
      sessionIds?: string[];
      transcriptUrl?: string | null;
      intentSessionContext?: string[];
      rawSessionPrompts?: string | null;
      commitSha?: string;
      commitDiffPatch?: string;
      commitDiffPatchSha256?: string;
      commitDiffPatchTruncated?: boolean;
      commitDiffPatchOriginalChars?: number;
      contextResolution?: 'direct' | 'branch_fallback';
      contextResolutionOriginalCheckpointId?: string;
      contextResolutionResolvedCheckpointId?: string;
      contextResolutionResolvedCommitSha?: string;
      contextResolutionResolvedCommitMessage?: string;
      checkpointSelectionMode?: 'latest' | 'last_n' | 'range';
      includedCheckpoints?: Array<{
        checkpointId: string;
        commitSha: string;
        commitSubject: string;
      }>;
      localCochange?: {
        source: 'local_git';
        checkpointsRef?: string;
        lookbackSessions: number;
        topN: number;
        sessionsScanned: number;
        relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
      };
    };
  }
): Promise<ReviewCreateResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews`, {
    method: 'POST',
    headers: withReviewHeaders({
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<ReviewCreateResponse>;
}

export async function createReviewPolicy(
  workerUrl: string,
  payload: {
    rawSessionPrompts: string;
    intentSessionContext?: string[];
    model?: string;
  }
): Promise<ReviewPolicyResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews/policy`, {
    method: 'POST',
    headers: withReviewHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<ReviewPolicyResponse>;
}

export async function deriveReviewPolicy(
  workerUrl: string,
  payload: {
    workspaceId: string;
    deploymentId: string;
    policyMode?: Exclude<ReviewPolicyMode, 'none'>;
    reviewBasis?: ReviewBasis;
    provenance?: Record<string, unknown>;
  }
): Promise<ReviewPolicyDeriveResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews/policy/derive`, {
    method: 'POST',
    headers: withReviewHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<ReviewPolicyDeriveResponse>;
}

export async function approveReviewPolicy(
  workerUrl: string,
  reviewId: string,
  payload: {
    approvedPolicy: {
      goal: string | null;
      prohibitions: string[];
      constraints: string[];
    };
  }
): Promise<ReviewPolicyApproveResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews/${encodeURIComponent(reviewId)}/policy/approve`, {
    method: 'POST',
    headers: withReviewHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<ReviewPolicyApproveResponse>;
}

export async function getReview(workerUrl: string, reviewId: string): Promise<ReviewGetResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews/${reviewId}`, {
    headers: withReviewHeaders(),
  });
  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<ReviewGetResponse>;
}

function parseSseChunk(chunk: string): ReviewEventEnvelope[] {
  const messages = chunk.split('\n\n');
  const events: ReviewEventEnvelope[] = [];

  for (const message of messages) {
    const trimmed = message.trim();
    if (!trimmed) {
      continue;
    }

    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('id:')) {
        id = line.slice(3).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      continue;
    }

    const payload = dataLines.join('\n');
    try {
      events.push({
        id,
        data: JSON.parse(payload) as Record<string, unknown>,
      });
    } catch {
      for (const dataLine of dataLines) {
        events.push({
          id,
          data: JSON.parse(dataLine) as Record<string, unknown>,
        });
      }
    }
  }

  return events;
}

export async function streamReviewEvents(
  workerUrl: string,
  reviewId: string,
  onEvent: (event: ReviewEventEnvelope) => void | Promise<void>
): Promise<void> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/reviews/${reviewId}/events`, {
    headers: withReviewHeaders({
      Accept: 'text/event-stream',
    }),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  if (!response.body) {
    const bodyText = await response.text();
    for (const event of parseSseChunk(bodyText)) {
      await onEvent(event);
    }
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const event of parseSseChunk(part)) {
        await onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  for (const event of parseSseChunk(buffer)) {
    await onEvent(event);
  }
}
