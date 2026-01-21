import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { GeneratedFile, SSEEvent } from './types.js';

// Re-export Sandbox class for Durable Object binding
export { Sandbox } from '@cloudflare/sandbox';

type SSEWriter = (event: SSEEvent) => void;

export async function buildInSandbox(
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  files: GeneratedFile[],
  sendEvent: SSEWriter,
  hostname: string
): Promise<string> {
  // Create a unique sandbox instance for this build
  const sandboxId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sandbox = getSandbox(sandboxNamespace, sandboxId);

  try {
    // Step 1: Scaffold Astro project
    sendEvent({ type: 'scaffolding' });
    const scaffoldResult = await sandbox.exec(
      'npm create astro@latest app -- --template basics --typescript strict --yes',
      { timeout: 120000 } // 2 minute timeout for scaffolding
    );

    if (scaffoldResult.exitCode !== 0) {
      throw new Error(`Scaffold failed: ${scaffoldResult.stderr || scaffoldResult.stdout}`);
    }

    // Step 2: Write generated files
    sendEvent({ type: 'writing' });
    for (const file of files) {
      // Ensure path is relative to /workspace/app
      const fullPath = `/workspace/app/${file.path}`;
      await sandbox.writeFile(fullPath, file.content);
    }

    // Step 3: Install dependencies
    sendEvent({ type: 'installing' });
    const installResult = await sandbox.exec('cd /workspace/app && npm install', {
      timeout: 180000, // 3 minute timeout
    });

    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed: ${installResult.stderr || installResult.stdout}`);
    }

    // Step 4: Build the project
    sendEvent({ type: 'building' });
    const buildResult = await sandbox.exec('cd /workspace/app && npm run build', {
      timeout: 120000, // 2 minute timeout
    });

    if (buildResult.exitCode !== 0) {
      throw new Error(`npm run build failed: ${buildResult.stderr || buildResult.stdout}`);
    }

    // Step 5: Start preview server
    sendEvent({ type: 'starting' });
    
    // Run preview server in background
    // Note: Astro preview runs on port 4321 by default
    await sandbox.exec('cd /workspace/app && npm run preview &', {
      timeout: 30000,
    });

    // Wait a moment for the server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Expose the preview port
    const preview = await sandbox.exposePort(4321, { hostname });

    return preview.url;
  } catch (error) {
    // On error, try to clean up the sandbox
    try {
      await sandbox.destroy();
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
