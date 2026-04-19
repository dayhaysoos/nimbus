import type { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

export const WORKSPACE_ROOT = '/workspace';
const BUNDLE_BASE64_PATH = '/tmp/review-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/review-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/review-source.tar.gz.base64.part';
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;
const DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS = 30_000;
const REVIEW_SANDBOX_ARCHIVE_TIMEOUT_MS = 2 * 60_000;

export interface SandboxClient {
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
  destroy?(): Promise<void>;
}

export function shellQuote(value: string): string {
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

export async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  timeout = DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  const result = await sandbox.exec(command, { timeout });
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function writeBundleBase64InChunks(sandbox: SandboxClient, bundleBytes: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(bundleBytes);
  await runSandboxCommand(sandbox, `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`);

  let partIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BUNDLE_BASE64_CHUNK_BYTES, bytes.byteLength));
    const chunkBase64 = toBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    const partPath = `${BUNDLE_BASE64_PART_PREFIX}.${String(partIndex).padStart(4, '0')}`;
    await sandbox.writeFile(partPath, chunkBase64);
    partIndex += 1;
  }

  await runSandboxCommand(
    sandbox,
    `cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`,
    REVIEW_SANDBOX_ARCHIVE_TIMEOUT_MS
  );
}

export async function hydrateReviewSandbox(sandbox: SandboxClient, sourceBytes: ArrayBuffer): Promise<void> {
  await runSandboxCommand(
    sandbox,
    `rm -rf ${shellQuote(WORKSPACE_ROOT)} && mkdir -p ${shellQuote(WORKSPACE_ROOT)}`,
    REVIEW_SANDBOX_ARCHIVE_TIMEOUT_MS
  );
  await writeBundleBase64InChunks(sandbox, sourceBytes);
  await runSandboxCommand(
    sandbox,
    `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(WORKSPACE_ROOT)}`,
    REVIEW_SANDBOX_ARCHIVE_TIMEOUT_MS
  );
  await runSandboxCommand(
    sandbox,
    `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`,
    REVIEW_SANDBOX_ARCHIVE_TIMEOUT_MS
  );
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

let sandboxResolver: (env: Env, sandboxId: string) => Promise<SandboxClient> = getWorkspaceSandbox;

export function setReviewAnalysisSandboxResolverForTests(
  resolver: ((env: Env, sandboxId: string) => Promise<SandboxClient>) | null
): void {
  sandboxResolver = resolver ?? getWorkspaceSandbox;
}

export async function resolveReviewSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  return sandboxResolver(env, sandboxId);
}
