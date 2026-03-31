import type { Sandbox } from '@cloudflare/sandbox';
import type { Env } from '../../types.js';

export const WORKSPACE_ROOT = '/workspace';

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

export function isSandboxAlreadyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(sandbox.*not found|sandbox.*does not exist|no such sandbox|already destroyed)/i.test(message);
}
