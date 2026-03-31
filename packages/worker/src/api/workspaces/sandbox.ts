import type { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

export const WORKSPACE_ROOT = '/workspace';
const BUNDLE_BASE64_PATH = '/tmp/workspace-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/workspace-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/workspace-source.tar.gz.base64.part';
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;

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
  destroy(): Promise<void>;
}

interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

export async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

export async function executeSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<SandboxCommandResult> {
  return sandbox.exec(command, options);
}

export async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<void> {
  const result = await executeSandboxCommand(sandbox, command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
}

export async function runSandboxCommandWithOutput(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<string> {
  const result = await executeSandboxCommand(sandbox, command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }

  return result.stdout;
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

  await runSandboxCommand(sandbox, `cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`);
}

export async function hydrateWorkspaceFilesystem(env: Env, sandboxId: string, sourceBytes: ArrayBuffer): Promise<void> {
  const sandbox = await getWorkspaceSandbox(env, sandboxId);

  await runSandboxCommand(sandbox, `rm -rf ${shellQuote(WORKSPACE_ROOT)} && mkdir -p ${shellQuote(WORKSPACE_ROOT)}`);
  await writeBundleBase64InChunks(sandbox, sourceBytes);
  await runSandboxCommand(
    sandbox,
    `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(WORKSPACE_ROOT)}`,
    { timeout: 8 * 60 * 1000 }
  );
  await runSandboxCommand(
    sandbox,
    `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`
  );
}

export async function resolveWorkspaceRealPath(sandbox: SandboxClient, requestedPath: string): Promise<string> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && realpath -- ${shellQuote(requestedPath)}`
  );

  return output.replace(/\r?\n$/, '');
}

export async function exportWorkspaceZipBase64(sandbox: SandboxClient): Promise<string> {
  return runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && tmp_zip=$(mktemp /tmp/nimbus-workspace-export.XXXXXX.zip) && rm -f "$tmp_zip" && if command -v zip >/dev/null 2>&1; then zip -q -r "$tmp_zip" . -x '.git/*' '*/.git/*' '*/._*' '._*'; else python3 - "$tmp_zip" <<'PY'
import os
import sys
import zipfile

zip_path = sys.argv[1]
root = os.getcwd()
with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):
            continue
        dirnames[:] = [d for d in dirnames if d != '.git' and not d.startswith('._')]
        for name in filenames:
            if name.startswith('._'):
                continue
            abs_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(abs_path, root)
            if rel_path == '.git' or rel_path.startswith('.git' + os.sep):
                continue
            zf.write(abs_path, rel_path)
PY
fi && base64 "$tmp_zip" && rm -f "$tmp_zip"`
  );
}

export function isSandboxAlreadyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(sandbox.*not found|sandbox.*does not exist|no such sandbox|already destroyed)/i.test(message);
}
