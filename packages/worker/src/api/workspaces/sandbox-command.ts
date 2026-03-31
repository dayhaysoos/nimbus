import type { SandboxClient } from './sandbox-client.js';

interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
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
