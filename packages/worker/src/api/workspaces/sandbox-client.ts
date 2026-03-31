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

export async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

export function isSandboxAlreadyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(sandbox.*not found|sandbox.*does not exist|no such sandbox|already destroyed)/i.test(message);
}
