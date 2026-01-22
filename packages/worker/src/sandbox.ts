import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { GeneratedFile, SSEEvent } from './types.js';

// Re-export Sandbox class for Durable Object binding
export { Sandbox } from '@cloudflare/sandbox';

type SSEWriter = (event: SSEEvent) => void;

export async function buildInSandbox(
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  files: GeneratedFile[],
  sendEvent: SSEWriter,
  _hostname: string // Will be used for preview URLs in later slice
): Promise<string> {
  // Create a unique sandbox instance for this build
  const sandboxId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sandbox = getSandbox(sandboxNamespace, sandboxId);

  const APP_DIR = '/root/app';

  try {
    // Step 1: Scaffold Astro project
    sendEvent({ type: 'scaffolding' });
    
    // Create the app directory and scaffold Astro project in the home directory
    const scaffoldResult = await sandbox.exec(
      `npm create astro@latest ${APP_DIR} -- --template basics --typescript strict --install --yes`,
      { timeout: 180000 } // 3 minute timeout for scaffolding + install
    );

    if (scaffoldResult.exitCode !== 0) {
      throw new Error(`Scaffold failed (exit ${scaffoldResult.exitCode}): ${scaffoldResult.stderr || scaffoldResult.stdout}`);
    }

    // Verify the project was created
    const verifyResult = await sandbox.exec(`ls -la ${APP_DIR}/package.json`);
    if (verifyResult.exitCode !== 0) {
      // Try to debug what happened
      const lsResult = await sandbox.exec('ls -la /root');
      throw new Error(`Astro project not created at ${APP_DIR}. Contents of /root: ${lsResult.stdout}`);
    }

    // Step 2: Write generated files (overwrite scaffolded files)
    sendEvent({ type: 'writing' });
    for (const file of files) {
      const fullPath = `${APP_DIR}/${file.path}`;
      // Ensure parent directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await sandbox.exec(`mkdir -p ${dir}`);
      await sandbox.writeFile(fullPath, file.content);
    }

    // Step 3: Install dependencies (in case new deps were added)
    sendEvent({ type: 'installing' });
    const installResult = await sandbox.exec(`cd ${APP_DIR} && npm install`, {
      timeout: 180000, // 3 minute timeout
    });

    if (installResult.exitCode !== 0) {
      throw new Error(`npm install failed (exit ${installResult.exitCode}): ${installResult.stderr || installResult.stdout}`);
    }

    // Step 4: Build the project
    sendEvent({ type: 'building' });
    const buildResult = await sandbox.exec(`cd ${APP_DIR} && npm run build`, {
      timeout: 120000, // 2 minute timeout
    });

    if (buildResult.exitCode !== 0) {
      throw new Error(`npm run build failed (exit ${buildResult.exitCode}): ${buildResult.stderr || buildResult.stdout}`);
    }

    // For Slice 0: Skip preview server - just confirm build succeeded
    // Preview URLs will be implemented in a later slice
    
    // Verify the build output exists
    const distCheck = await sandbox.exec(`ls ${APP_DIR}/dist`);
    if (distCheck.exitCode !== 0) {
      throw new Error(`Build output not found at ${APP_DIR}/dist`);
    }

    return `Build succeeded! Output at ${APP_DIR}/dist. (Preview URLs coming in next slice)`;
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
