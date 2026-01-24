import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { GeneratedFile, SSEEvent } from './types.js';

// Re-export Sandbox class for Durable Object binding
export { Sandbox } from '@cloudflare/sandbox';

type SSEWriter = (event: SSEEvent) => void;

// Timeouts in milliseconds
const INSTALL_TIMEOUT = 300000; // 5 minutes for dependency installation
const BUILD_TIMEOUT = 180000; // 3 minutes for build

export interface BuildResult {
  previewUrl: string;
  sandboxId: string;
  installDurationMs: number;
  buildDurationMs: number;
}

export async function buildInSandbox(
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  files: GeneratedFile[],
  sendEvent: SSEWriter,
  hostname: string
): Promise<BuildResult> {
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

    let installDurationMs = 0;
    let buildDurationMs = 0;

    if (hasPackageJson) {
      // Step 3: Install dependencies using bun (much faster than npm)
      sendEvent({ type: 'installing' });
      const installStart = Date.now();

      // Use bun install - it's 10-100x faster than npm
      // Falls back to npm if bun fails
      let installResult = await sandbox.exec(`cd ${APP_DIR} && bun install --no-save`, {
        timeout: INSTALL_TIMEOUT,
      });

      // If bun fails, try npm as fallback
      if (installResult.exitCode !== 0) {
        installResult = await sandbox.exec(`cd ${APP_DIR} && npm install --prefer-offline --no-audit --no-fund`, {
          timeout: INSTALL_TIMEOUT,
        });
      }

      installDurationMs = Date.now() - installStart;

      if (installResult.exitCode !== 0) {
        const output = [installResult.stdout, installResult.stderr].filter(Boolean).join('\n');
        throw new Error(`Install failed (exit ${installResult.exitCode}):\n${output || 'No output'}`);
      }

      // Step 4: Build if there's a build script
      sendEvent({ type: 'building' });
      const packageJsonFile = files.find(f => f.path === 'package.json');
      const hasBuildScript = packageJsonFile && packageJsonFile.content.includes('"build"');

      if (hasBuildScript) {
        const buildStart = Date.now();
        // Use bun run for build - also faster
        // For Astro/Vite, need to set CI=true to avoid interactive prompts
        let buildResult = await sandbox.exec(`cd ${APP_DIR} && CI=true bun run build`, {
          timeout: BUILD_TIMEOUT,
        });

        // If bun fails, try npm as fallback
        if (buildResult.exitCode !== 0) {
          buildResult = await sandbox.exec(`cd ${APP_DIR} && CI=true npm run build`, {
            timeout: BUILD_TIMEOUT,
          });
        }

        buildDurationMs = Date.now() - buildStart;

        if (buildResult.exitCode !== 0) {
          // Include both stdout and stderr for better debugging
          const output = [buildResult.stdout, buildResult.stderr].filter(Boolean).join('\n');
          throw new Error(`Build failed (exit ${buildResult.exitCode}):\n${output || 'No output'}`);
        }
      }
    } else {
      // Static HTML/CSS project - no build needed
      sendEvent({ type: 'installing' });
      sendEvent({ type: 'building' });
    }

    // Start HTTP server and expose preview URL
    sendEvent({ type: 'starting' });

    // Determine what to serve and how
    const packageJsonFile = files.find(f => f.path === 'package.json');
    let packageJson: { scripts?: Record<string, string> } = {};
    if (packageJsonFile) {
      try {
        packageJson = JSON.parse(packageJsonFile.content);
      } catch {
        // Ignore parse errors
      }
    }

    // Check for preview/start scripts or determine serve directory
    const hasPreviewScript = packageJson.scripts?.preview;
    const hasStartScript = packageJson.scripts?.start;

    if (hasPreviewScript) {
      // Astro, Vite, etc. have a preview script that serves the built output
      await sandbox.startProcess(`cd ${APP_DIR} && bun run preview -- --host 0.0.0.0 --port 8080`);
    } else if (hasStartScript) {
      // Some projects have a start script - try to set port via PORT env var (common convention)
      await sandbox.startProcess(`cd ${APP_DIR} && PORT=8080 bun run start`);
    } else {
      // Static files - use npx serve to serve the appropriate directory
      // Check if there's a dist/ or build/ folder after build
      const distExists = await sandbox.exec(`test -d ${APP_DIR}/dist && echo "yes" || echo "no"`);
      const buildExists = await sandbox.exec(`test -d ${APP_DIR}/build && echo "yes" || echo "no"`);

      let serveDir = APP_DIR;
      if (distExists.stdout?.trim() === 'yes') {
        serveDir = `${APP_DIR}/dist`;
      } else if (buildExists.stdout?.trim() === 'yes') {
        serveDir = `${APP_DIR}/build`;
      }

      // Use serve for static file serving (installed globally in Dockerfile)
      await sandbox.startProcess(`serve ${serveDir} -l 8080 --no-clipboard`);
    }

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Expose the port and get preview URL
    const exposed = await sandbox.exposePort(8080, { hostname });

    return {
      previewUrl: exposed.url,
      sandboxId,
      installDurationMs,
      buildDurationMs,
    };
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
