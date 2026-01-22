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

  const APP_DIR = '/root/app';

  try {
    // Step 1: Create project directory
    sendEvent({ type: 'scaffolding' });
    await sandbox.exec(`mkdir -p ${APP_DIR}`);

    // Step 2: Write generated files
    sendEvent({ type: 'writing' });
    for (const file of files) {
      const fullPath = `${APP_DIR}/${file.path}`;
      // Ensure parent directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir && dir !== APP_DIR) {
        await sandbox.exec(`mkdir -p ${dir}`);
      }
      await sandbox.writeFile(fullPath, file.content);
    }

    // Check if this is a Node.js project (has package.json)
    const hasPackageJson = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
    
    if (hasPackageJson) {
      // Step 3: Install dependencies
      sendEvent({ type: 'installing' });
      const installResult = await sandbox.exec(`cd ${APP_DIR} && npm install`, {
        timeout: 180000,
      });

      if (installResult.exitCode !== 0) {
        throw new Error(`npm install failed (exit ${installResult.exitCode}): ${installResult.stderr || installResult.stdout}`);
      }

      // Step 4: Build if there's a build script
      sendEvent({ type: 'building' });
      const packageJsonFile = files.find(f => f.path === 'package.json');
      const hasBuildScript = packageJsonFile && packageJsonFile.content.includes('"build"');
      
      if (hasBuildScript) {
        const buildResult = await sandbox.exec(`cd ${APP_DIR} && npm run build`, {
          timeout: 120000,
        });

        if (buildResult.exitCode !== 0) {
          throw new Error(`npm run build failed (exit ${buildResult.exitCode}): ${buildResult.stderr || buildResult.stdout}`);
        }
      }
    } else {
      // Static HTML/CSS project - no build needed
      sendEvent({ type: 'installing' });
      sendEvent({ type: 'building' });
    }

    // List what was created
    sendEvent({ type: 'starting' });
    const lsResult = await sandbox.exec(`ls -la ${APP_DIR}`);
    const fileList = lsResult.stdout || 'Files written successfully';

    // For Slice 0, just return the file list
    // Preview URLs will be implemented properly in a future slice
    return `Build succeeded! Files at ${APP_DIR}:\n${fileList}`;
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
