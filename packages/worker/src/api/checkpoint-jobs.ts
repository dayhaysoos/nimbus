import type { Env } from '../types.js';
import { createCheckpointJob, deleteJob, generateJobId, updateJobStatus } from '../lib/db.js';
import { createCheckpointJobQueueMessage } from '../lib/checkpoint-queue.js';
import { normalizeProjectRoot } from '../lib/checkpoint-plan.js';

export const MAX_SOURCE_BUNDLE_BYTES = 100 * 1024 * 1024;

const CHECKPOINT_ID_REGEX = /^[a-f0-9]{12}$/i;
const COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export interface CheckpointJobMetadata {
  source: {
    type: 'checkpoint';
    checkpointId: string | null;
    commitSha: string;
    ref?: string;
    projectRoot?: string;
  };
  build: {
    runTestsIfPresent: boolean;
    runLintIfPresent: boolean;
  };
}

export interface ParsedCheckpointCreateRequest {
  metadata: CheckpointJobMetadata;
  bundle: {
    type: string;
  };
  bundleBytes: number;
  bundleSha256: string;
  bundleArrayBuffer: ArrayBuffer;
}

interface MultipartFileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isMultipartFileLike(value: unknown): value is MultipartFileLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MultipartFileLike>;
  return (
    typeof candidate.size === 'number' &&
    typeof candidate.type === 'string' &&
    typeof candidate.arrayBuffer === 'function'
  );
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected string`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseCheckpointJobMetadata(metadataJson: string): CheckpointJobMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    throw new Error('Invalid metadata JSON');
  }

  const root = requireObject(parsed, 'Invalid metadata payload');
  const source = requireObject(root.source, 'Invalid metadata.source');
  const build = requireObject(root.build, 'Invalid metadata.build');

  if (source.type !== 'checkpoint') {
    throw new Error('Invalid metadata.source.type: expected "checkpoint"');
  }

  const checkpointIdValue = source.checkpointId;
  let checkpointId: string | null = null;
  if (checkpointIdValue !== undefined && checkpointIdValue !== null) {
    if (typeof checkpointIdValue !== 'string' || !CHECKPOINT_ID_REGEX.test(checkpointIdValue.trim())) {
      throw new Error('Invalid metadata.source.checkpointId: expected 12-char hex or null');
    }

    checkpointId = checkpointIdValue.trim().toLowerCase();
  }

  const commitShaValue = source.commitSha;
  if (typeof commitShaValue !== 'string' || !COMMIT_SHA_REGEX.test(commitShaValue.trim())) {
    throw new Error('Invalid metadata.source.commitSha: expected full 40-char git commit SHA');
  }

  const runTestsIfPresent = build.runTestsIfPresent;
  const runLintIfPresent = build.runLintIfPresent;

  if (typeof runTestsIfPresent !== 'boolean') {
    throw new Error('Invalid metadata.build.runTestsIfPresent: expected boolean');
  }

  if (typeof runLintIfPresent !== 'boolean') {
    throw new Error('Invalid metadata.build.runLintIfPresent: expected boolean');
  }

  let projectRoot: string | undefined;
  try {
    const parsedProjectRoot = parseOptionalString(source.projectRoot, 'metadata.source.projectRoot');
    if (parsedProjectRoot !== undefined) {
      projectRoot = normalizeProjectRoot(parsedProjectRoot);
    }
  } catch {
    throw new Error('Invalid metadata.source.projectRoot: expected safe relative directory path');
  }

  return {
    source: {
      type: 'checkpoint',
      checkpointId,
      commitSha: commitShaValue.trim().toLowerCase(),
      ref: parseOptionalString(source.ref, 'metadata.source.ref'),
      projectRoot,
    },
    build: {
      runTestsIfPresent,
      runLintIfPresent,
    },
  };
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

async function sha256Hex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

export async function parseCheckpointCreateRequest(
  request: Request,
  maxBundleBytes = MAX_SOURCE_BUNDLE_BYTES
): Promise<ParsedCheckpointCreateRequest> {
  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    throw new Error('Invalid multipart form body');
  }

  const metadataField = formData.get('metadata');
  if (typeof metadataField !== 'string') {
    throw new Error('Missing metadata form field');
  }

  const metadata = parseCheckpointJobMetadata(metadataField);

  const bundleField = formData.get('bundle');
  if (!isMultipartFileLike(bundleField)) {
    throw new Error('Missing bundle form file');
  }

  if (bundleField.size <= 0) {
    throw new Error('Source bundle is empty');
  }

  if (bundleField.size > maxBundleBytes) {
    throw new Error(`Source bundle exceeds max size of ${maxBundleBytes} bytes`);
  }

  const bundleArrayBuffer = await bundleField.arrayBuffer();
  const bundleSha256 = await sha256Hex(bundleArrayBuffer);

  return {
    metadata,
    bundle: bundleField,
    bundleBytes: bundleArrayBuffer.byteLength,
    bundleSha256,
    bundleArrayBuffer,
  };
}

function checkpointPrompt(checkpointId: string | null, commitSha: string): string {
  if (checkpointId) {
    return `Deploy checkpoint ${checkpointId}`;
  }

  return `Deploy commit ${commitSha.slice(0, 12)}`;
}

function sourceBundleR2Key(jobId: string, commitSha: string): string {
  return `jobs/${jobId}/source/${commitSha}.tar.gz`;
}

export async function handleCreateCheckpointJob(request: Request, env: Env): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return new Response(
      JSON.stringify({ error: 'SOURCE_BUNDLES R2 binding is not configured' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  if (!env.CHECKPOINT_JOBS_QUEUE) {
    return new Response(
      JSON.stringify({ error: 'CHECKPOINT_JOBS_QUEUE binding is not configured' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      }
    );
  }

  let parsed: ParsedCheckpointCreateRequest;

  try {
    parsed = await parseCheckpointCreateRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const jobId = generateJobId();
  const sourceBundleKey = sourceBundleR2Key(jobId, parsed.metadata.source.commitSha);
  let bundleUploaded = false;
  let jobPersisted = false;
  let jobDeleted = false;

  try {
    await env.SOURCE_BUNDLES.put(sourceBundleKey, parsed.bundleArrayBuffer, {
      httpMetadata: {
        contentType: parsed.bundle.type || 'application/gzip',
      },
      customMetadata: {
        source_type: parsed.metadata.source.type,
        commit_sha: parsed.metadata.source.commitSha,
        checkpoint_id: parsed.metadata.source.checkpointId ?? '',
        source_project_root: parsed.metadata.source.projectRoot ?? '',
        build_run_tests_if_present: String(parsed.metadata.build.runTestsIfPresent),
        build_run_lint_if_present: String(parsed.metadata.build.runLintIfPresent),
      },
    });
    bundleUploaded = true;

    await createCheckpointJob(env.DB, {
      id: jobId,
      prompt: checkpointPrompt(parsed.metadata.source.checkpointId, parsed.metadata.source.commitSha),
      checkpointId: parsed.metadata.source.checkpointId,
      commitSha: parsed.metadata.source.commitSha,
      sourceRef: parsed.metadata.source.ref,
      sourceProjectRoot: parsed.metadata.source.projectRoot,
      buildRunTestsIfPresent: parsed.metadata.build.runTestsIfPresent,
      buildRunLintIfPresent: parsed.metadata.build.runLintIfPresent,
      sourceBundleKey,
      sourceBundleSha256: parsed.bundleSha256,
      sourceBundleBytes: parsed.bundleBytes,
    });
    jobPersisted = true;

    await env.CHECKPOINT_JOBS_QUEUE.send(createCheckpointJobQueueMessage(jobId));
  } catch (error) {
    if (jobPersisted) {
      try {
        await deleteJob(env.DB, jobId);
        jobDeleted = true;
      } catch (deleteError) {
        const deleteMessage = deleteError instanceof Error ? deleteError.message : String(deleteError);

        try {
          await updateJobStatus(env.DB, jobId, 'failed', {
            phase: 'failed',
            completed_at: new Date().toISOString(),
            error_message: `Queue enqueue failed and cleanup delete failed: ${deleteMessage}`,
          });
        } catch {
          // Best-effort fallback only.
        }

        // Best-effort cleanup only.
      }
    }

    if (bundleUploaded && (!jobPersisted || jobDeleted)) {
      try {
        await env.SOURCE_BUNDLES.delete(sourceBundleKey);
      } catch {
        // Best-effort cleanup only.
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: `Failed to create checkpoint job: ${message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return new Response(
    JSON.stringify({
      jobId,
      status: 'queued',
      phase: 'queued',
      eventsUrl: `/api/jobs/${jobId}/events`,
      jobUrl: `/api/jobs/${jobId}`,
    }),
    {
      status: 202,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    }
  );
}
