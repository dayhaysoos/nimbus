import type { Sandbox } from '@cloudflare/sandbox';
import { appendJobEvent, claimQueuedCheckpointJob, getJob, updateJobStatus } from './db.js';
import {
  buildCheckpointExecutionPlan,
  detectPackageManager,
  resolveProjectDir,
} from './checkpoint-plan.js';
import type { Env, JobResponse, JobStatus } from '../types.js';

const SOURCE_ROOT = '/root/checkpoint-source';
const BUNDLE_BASE64_PATH = '/tmp/checkpoint-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/checkpoint-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/checkpoint-source.tar.gz.base64.part';
// Keep chunk size divisible by 3 so non-final base64 chunks never include padding.
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;

const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const BUILD_TIMEOUT_MS = 8 * 60 * 1000;
const VALIDATION_TIMEOUT_MS = 8 * 60 * 1000;

const LOCKFILE_NAMES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

export function isValidBase64ChunkSize(size: number): boolean {
  return size > 0 && size % 3 === 0;
}

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, contents: string): Promise<unknown>;
  readFile(path: string, options?: { encoding?: string }): Promise<unknown>;
  destroy(): Promise<void>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function writeBundleBase64InChunks(sandbox: SandboxClient, bundleBytes: ArrayBuffer): Promise<void> {
  if (!isValidBase64ChunkSize(BUNDLE_BASE64_CHUNK_BYTES)) {
    throw new Error('Invalid base64 chunk size configuration: chunk size must be divisible by 3');
  }

  const bytes = new Uint8Array(bundleBytes);

  await sandbox.exec(`rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`);

  let partIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BUNDLE_BASE64_CHUNK_BYTES, bytes.byteLength));
    const chunkBase64 = toBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    const partPath = `${BUNDLE_BASE64_PART_PREFIX}.${String(partIndex).padStart(4, '0')}`;
    await sandbox.writeFile(partPath, chunkBase64);
    partIndex += 1;
  }

  await sandbox.exec(`cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`);
}

async function requeueForRetry(db: D1Database, jobId: string, reason: string): Promise<void> {
  await updateJobStatus(db, jobId, 'queued', {
    phase: 'queued',
    started_at: null,
    completed_at: null,
    error_message: `Retrying checkpoint queue processing: ${reason}`,
  });
}

async function appendJobStartedEvent(db: D1Database, job: JobResponse): Promise<void> {
  await appendJobEvent(db, {
    jobId: job.id,
    eventType: 'job_started',
    phase: 'building',
    payload: {
      sourceType: job.sourceType,
      checkpointId: job.checkpointId,
      commitSha: job.commitSha,
    },
  });
}

async function runCommand(
  sandbox: SandboxClient,
  projectDir: string,
  command: string,
  timeout: number
): Promise<void> {
  const result = await sandbox.exec(`cd ${shellQuote(projectDir)} && ${command}`, { timeout });

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Command failed (${command}) with exit ${result.exitCode}: ${output || 'No output'}`);
  }
}

async function fileExists(
  sandbox: SandboxClient,
  path: string
): Promise<boolean> {
  const result = await sandbox.exec(`test -f ${shellQuote(path)} && echo yes || echo no`);
  return result.stdout.trim() === 'yes';
}

async function listLockfiles(
  sandbox: SandboxClient,
  projectDir: string
): Promise<string[]> {
  const files: string[] = [];

  for (const lockfile of LOCKFILE_NAMES) {
    if (await fileExists(sandbox, `${projectDir}/${lockfile}`)) {
      files.push(lockfile);
    }
  }

  return files;
}

async function resolveLockfileContext(
  sandbox: SandboxClient,
  projectDir: string
): Promise<{ installDir: string; lockfiles: string[] }> {
  const projectLockfiles = await listLockfiles(sandbox, projectDir);
  if (projectLockfiles.length > 0) {
    return {
      installDir: projectDir,
      lockfiles: projectLockfiles,
    };
  }

  if (projectDir !== SOURCE_ROOT) {
    const sourceRootLockfiles = await listLockfiles(sandbox, SOURCE_ROOT);
    if (sourceRootLockfiles.length > 0) {
      return {
        installDir: SOURCE_ROOT,
        lockfiles: sourceRootLockfiles,
      };
    }
  }

  return {
    installDir: projectDir,
    lockfiles: [],
  };
}

async function readPackageScripts(
  sandbox: SandboxClient,
  projectDir: string
): Promise<Record<string, string> | null> {
  const packageJsonPath = `${projectDir}/package.json`;
  const hasPackageJson = await fileExists(sandbox, packageJsonPath);

  if (!hasPackageJson) {
    return null;
  }

  const fileContent = (await sandbox.readFile(packageJsonPath, { encoding: 'utf8' })) as {
    content: string;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent.content);
  } catch {
    throw new Error('Invalid package.json in checkpoint source');
  }

  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }

  return normalized;
}

async function markFailed(db: D1Database, jobId: string, message: string): Promise<void> {
  await updateJobStatus(db, jobId, 'failed', {
    phase: 'failed',
    completed_at: new Date().toISOString(),
    error_message: message,
  });

  try {
    await appendJobEvent(db, {
      jobId,
      eventType: 'job_failed',
      phase: 'failed',
      payload: { message },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.warn(`[checkpoint-runner] Failed to persist failed event for ${jobId}: ${details}`);
  }
}

async function executeCheckpointBuild(env: Env, job: JobResponse): Promise<void> {
  if (!env.SOURCE_BUNDLES) {
    throw new QueueRetryError('SOURCE_BUNDLES binding is not configured');
  }

  if (!job.sourceBundleKey || !job.commitSha) {
    throw new Error('Checkpoint job is missing source bundle metadata');
  }

  const bundle = await env.SOURCE_BUNDLES.get(job.sourceBundleKey);
  if (!bundle) {
    throw new Error(`Source bundle not found: ${job.sourceBundleKey}`);
  }

  const sourceBytes = await bundle.arrayBuffer();

  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxId = `checkpoint-${job.id}-${Math.random().toString(36).slice(2, 10)}`;
  const sandbox = getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;

  try {
    await sandbox.exec(`rm -rf ${shellQuote(SOURCE_ROOT)} && mkdir -p ${shellQuote(SOURCE_ROOT)}`);
    await writeBundleBase64InChunks(sandbox, sourceBytes);

    await sandbox.exec(
      `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(SOURCE_ROOT)}`,
      { timeout: INSTALL_TIMEOUT_MS }
    );

    const projectDir = resolveProjectDir(SOURCE_ROOT, job.sourceProjectRoot);
    const projectDirCheck = await sandbox.exec(`test -d ${shellQuote(projectDir)} && echo yes || echo no`);
    if (projectDirCheck.stdout.trim() !== 'yes') {
      throw new Error(`Resolved project root is not a directory: ${job.sourceProjectRoot ?? '.'}`);
    }

    const scripts = await readPackageScripts(sandbox, projectDir);
    if (scripts !== null) {
      const { installDir, lockfiles } = await resolveLockfileContext(sandbox, projectDir);
      const packageManager = detectPackageManager(lockfiles);
      const plan = buildCheckpointExecutionPlan({
        packageManager,
        scripts,
        runTestsIfPresent: job.buildRunTestsIfPresent ?? true,
        runLintIfPresent: job.buildRunLintIfPresent ?? true,
      });

      await runCommand(sandbox, installDir, plan.install, INSTALL_TIMEOUT_MS);

      if (plan.build) {
        await runCommand(sandbox, projectDir, plan.build, BUILD_TIMEOUT_MS);
      }

      if (plan.test || plan.lint) {
        await updateJobStatus(env.DB, job.id, 'running', { phase: 'validating' });
      }

      if (plan.test) {
        await runCommand(sandbox, projectDir, plan.test, VALIDATION_TIMEOUT_MS);
      }

      if (plan.lint) {
        await runCommand(sandbox, projectDir, plan.lint, VALIDATION_TIMEOUT_MS);
      }
    }

    await updateJobStatus(env.DB, job.id, 'completed', {
      phase: 'completed',
      completed_at: new Date().toISOString(),
      error_message: null,
      error_code: null,
    });

    try {
      await appendJobEvent(env.DB, {
        jobId: job.id,
        eventType: 'job_completed',
        phase: 'completed',
        payload: {
          sourceType: job.sourceType,
          commitSha: job.commitSha,
        },
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.warn(`[checkpoint-runner] Failed to persist completion event for ${job.id}: ${details}`);
    }
  } finally {
    try {
      await sandbox.destroy();
    } catch {
      // Best-effort cleanup.
    }
  }
}

export async function processCheckpointJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env.DB, jobId);
  if (!job) {
    return;
  }

  if (job.sourceType !== 'checkpoint') {
    console.warn(`[checkpoint-runner] Ignoring queue message for non-checkpoint job ${job.id}`);
    return;
  }

  if (job.status === 'running' && (job.phase === 'building' || job.phase === 'validating')) {
    return;
  }

  if (job.status !== 'queued') {
    return;
  }

  const claimed = await claimQueuedCheckpointJob(env.DB, job.id);
  if (!claimed) {
    return;
  }

  try {
    await appendJobStartedEvent(env.DB, job);
  } catch (eventError) {
    const details = eventError instanceof Error ? eventError.message : String(eventError);
    try {
      await requeueForRetry(env.DB, job.id, `job-started-event: ${details}`);
    } catch (requeueError) {
      const requeueMessage = requeueError instanceof Error ? requeueError.message : String(requeueError);
      throw new QueueRetryError(
        `Failed to append job_started event: ${details}; additionally failed to requeue job status: ${requeueMessage}`
      );
    }

    throw new QueueRetryError(`Failed to append job_started event: ${details}`);
  }

  try {
    await executeCheckpointBuild(env, job);
  } catch (error) {
    if (error instanceof QueueRetryError) {
      try {
        await requeueForRetry(env.DB, job.id, error.message);
      } catch (requeueError) {
        const requeueMessage = requeueError instanceof Error ? requeueError.message : String(requeueError);
        throw new QueueRetryError(`${error.message}; additionally failed to requeue job status: ${requeueMessage}`);
      }

      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);

    try {
      await markFailed(env.DB, job.id, message);
    } catch (statusError) {
      const details = statusError instanceof Error ? statusError.message : String(statusError);

      try {
        await requeueForRetry(env.DB, job.id, `failed-status-update: ${details}`);
      } catch (requeueError) {
        const requeueMessage = requeueError instanceof Error ? requeueError.message : String(requeueError);
        throw new QueueRetryError(
          `Failed to mark checkpoint job as failed: ${details}; additionally failed to requeue job status: ${requeueMessage}`
        );
      }

      throw new QueueRetryError(`Failed to mark checkpoint job as failed: ${details}`);
    }
  }
}
