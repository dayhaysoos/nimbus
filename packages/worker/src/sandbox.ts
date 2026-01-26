import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { isNextWorkersConfig, parseNimbusConfig } from './lib/nimbus-config.js';
import { buildWorkerName } from './lib/worker-name.js';
import type { GeneratedFile, SSEEvent } from './types.js';

// Re-export Sandbox class for Durable Object binding
export { Sandbox } from '@cloudflare/sandbox';

type SSEWriter = (event: SSEEvent) => void;

// Timeouts in milliseconds
const INSTALL_TIMEOUT = 300000; // 5 minutes for dependency installation
const BUILD_TIMEOUT = 180000; // 3 minutes for build
const NEXTJS_BUILD_TIMEOUT = 120000; // 2 minutes for Next.js build
const OPENNEXT_BUILD_TIMEOUT = 60000; // 1 minute for OpenNext packaging
const WORKER_COMPATIBILITY_DATE = '2026-01-23';
const NIMBUS_WRANGLER_FILENAME = 'wrangler.nimbus.toml';
const PROJECT_WRANGLER_FILENAME = 'wrangler.toml';
const STATIC_WORKER_FILENAME = 'nimbus-static-worker.js';
const STATIC_WORKER_SOURCE = `export default { fetch: (request, env) => env.ASSETS.fetch(request) };\n`;
const SSE_HEARTBEAT_MS = 15000;
const MAX_LOG_CHARS = 4000;
const LOG_STREAM_INTERVAL_MS = 5000;

async function execWithTimeout(
  sandbox: ReturnType<typeof getSandbox>,
  command: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const execPromise = sandbox.exec(command, { timeout: timeoutMs });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
    }, timeoutMs);
  });

  try {
    return (await Promise.race([execPromise, timeoutPromise])) as {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildWranglerConfig(jobId: string): string {
  const workerName = buildWorkerName(jobId);
  return [
    `name = "${workerName}"`,
    'workers_dev = true',
    'main = ".open-next/worker.js"',
    `compatibility_date = "${WORKER_COMPATIBILITY_DATE}"`,
    'compatibility_flags = ["nodejs_compat"]',
    '',
    '[assets]',
    'directory = ".open-next/assets"',
    'binding = "ASSETS"',
    '',
  ].join('\n');
}

function buildWorkerWranglerConfig(
  jobId: string,
  workerEntry: string,
  assetsDir?: string
): string {
  const workerName = buildWorkerName(jobId);
  const lines = [
    `name = "${workerName}"`,
    'workers_dev = true',
    `main = "${workerEntry}"`,
    `compatibility_date = "${WORKER_COMPATIBILITY_DATE}"`,
    'compatibility_flags = ["nodejs_compat"]',
    '',
  ];
  if (assetsDir) {
    lines.push('[assets]', `directory = "${assetsDir}"`, 'binding = "ASSETS"', '');
  }
  return lines.join('\n');
}

function wrapWithTimeout(command: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `timeout ${seconds}s ${command}`;
}

function startHeartbeat(sendEvent: SSEWriter, type: SSEEvent['type']): () => void {
  const interval = setInterval(() => {
    sendEvent({ type } as SSEEvent);
  }, SSE_HEARTBEAT_MS);
  return () => clearInterval(interval);
}

function truncateLog(contents: string | null): string | null {
  if (!contents) {
    return null;
  }
  if (contents.length <= MAX_LOG_CHARS) {
    return contents;
  }
  return contents.slice(-MAX_LOG_CHARS);
}

async function readLogTail(
  sandbox: ReturnType<typeof getSandbox>,
  filePath: string,
  lineCount = 200
): Promise<string | null> {
  const result = await sandbox.exec(
    `if [ -f "${filePath}" ]; then tail -n ${lineCount} "${filePath}"; fi`
  );
  const output = result.stdout?.trim();
  return truncateLog(output || null);
}

function formatLogSection(label: string, contents: string | null): string {
  if (!contents) {
    return '';
  }
  return `\n--- ${label} (tail) ---\n${contents}`;
}

function ensureLogSection(message: string, label: string, contents: string | null): string {
  if (!contents) {
    return message;
  }
  if (message.includes(`${label} (tail)`)) {
    return message;
  }
  return `${message}${formatLogSection(label, contents)}`;
}

function getNewLogLines(
  contents: string,
  lastLine: string | null
): { message: string | null; lastLine: string | null } {
  const lines = contents.split('\n');
  const nextLastLine = lines.length > 0 ? lines[lines.length - 1] : null;
  if (!lastLine) {
    return { message: contents.trim() ? contents : null, lastLine: nextLastLine };
  }

  const lastIndex = lines.lastIndexOf(lastLine);
  if (lastIndex === -1) {
    return { message: contents.trim() ? contents : null, lastLine: nextLastLine };
  }

  const newLines = lines.slice(lastIndex + 1).filter((line) => line.trim().length > 0);
  if (newLines.length === 0) {
    return { message: null, lastLine: nextLastLine };
  }

  return { message: newLines.join('\n'), lastLine: nextLastLine };
}

function startLogStreamer(
  sandbox: ReturnType<typeof getSandbox>,
  sendEvent: SSEWriter,
  filePath: string,
  phase: 'install' | 'build'
): () => void {
  let lastLine: string | null = null;
  let isPolling = false;
  let stopped = false;

  const poll = async () => {
    if (isPolling || stopped) {
      return;
    }
    isPolling = true;
    try {
      const tail = await readLogTail(sandbox, filePath);
      if (!tail) {
        return;
      }
      const update = getNewLogLines(tail, lastLine);
      lastLine = update.lastLine;
      if (update.message) {
        sendEvent({ type: 'log', phase, message: update.message });
      }
    } catch {
      // Ignore log polling errors
    } finally {
      isPolling = false;
    }
  };

  const interval = setInterval(() => {
    void poll();
  }, LOG_STREAM_INTERVAL_MS);

  void poll();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export class SandboxBuildError extends Error {
  sandboxId: string;

  constructor(message: string, sandboxId: string) {
    super(message);
    this.sandboxId = sandboxId;
  }
}

async function findStaticAssetsDir(sandbox: ReturnType<typeof getSandbox>): Promise<string> {
  const appDir = '/root/app';
  const candidates = ['dist', 'build', '.output', 'out'];
  for (const dir of candidates) {
    const checkPath = `${appDir}/${dir}`;
    const result = await sandbox.exec(`test -d ${checkPath} && echo "exists"`);
    if (result.stdout.includes('exists')) {
      return dir;
    }
  }
  return '.';
}

async function resolveStaticAssetsDir(
  sandbox: ReturnType<typeof getSandbox>,
  config: { assetsDir?: string } | null
): Promise<string> {
  if (config?.assetsDir) {
    const normalized = config.assetsDir.replace(/^\.\//, '');
    const checkPath = `/root/app/${normalized}`;
    const result = await sandbox.exec(`test -d ${checkPath} && echo "exists"`);
    if (result.stdout.includes('exists')) {
      return normalized;
    }
  }
  return findStaticAssetsDir(sandbox);
}

function resolveStaticWorkerEntry(
  files: GeneratedFile[],
  config: { workerEntry?: string } | null
): { path: string; contents?: string } {
  const configuredEntry = config?.workerEntry;
  if (configuredEntry && files.some((file) => file.path === configuredEntry)) {
    return { path: configuredEntry };
  }
  const explicitWorker = files.find((file) => /(^|\/)(worker)\.(js|ts)$/.test(file.path));
  if (explicitWorker) {
    return { path: explicitWorker.path };
  }
  return { path: STATIC_WORKER_FILENAME, contents: STATIC_WORKER_SOURCE };
}

async function ensureAssetsIgnore(
  sandbox: ReturnType<typeof getSandbox>,
  assetsDir: string | undefined
): Promise<void> {
  if (!assetsDir) {
    return;
  }
  const assetsRoot = `/root/app/${assetsDir}`;
  const workerAssetsPath = `${assetsRoot}/_worker.js`;
  const workerDirCheck = await sandbox.exec(
    `test -d "${workerAssetsPath}" && echo "yes" || echo "no"`
  );
  if (workerDirCheck.stdout?.trim() !== 'yes') {
    return;
  }

  const ignorePath = `${assetsRoot}/.assetsignore`;
  const existing = await sandbox.exec(`if [ -f "${ignorePath}" ]; then cat "${ignorePath}"; fi`);
  const contents = existing.stdout ?? '';
  const hasEntry = contents
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === '_worker.js');
  if (hasEntry) {
    return;
  }

  const trimmed = contents.replace(/\s+$/, '');
  const nextContents = `${trimmed}${trimmed ? '\n' : ''}_worker.js\n`;
  await sandbox.writeFile(ignorePath, nextContents);
}

export interface BuildResult {
  sandboxId: string;
  installDurationMs: number;
  buildDurationMs: number;
}

export async function buildInSandbox(
  sandboxNamespace: DurableObjectNamespace<Sandbox>,
  files: GeneratedFile[],
  sendEvent: SSEWriter,
  jobId: string
): Promise<BuildResult> {
  // Create a unique sandbox instance for this build
  const sandboxId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sandbox = getSandbox(sandboxNamespace, sandboxId);

  const APP_DIR = '/root/app';
  const LOG_DIR = `${APP_DIR}/.nimbus`;
  const INSTALL_LOG_PATH = `${LOG_DIR}/install.log`;
  const BUILD_LOG_PATH = `${LOG_DIR}/build.log`;

  try {
    // Step 1: Create project directory
    sendEvent({ type: 'scaffolding' });
    await sandbox.exec(`mkdir -p ${APP_DIR}`);
    await sandbox.exec(`mkdir -p ${LOG_DIR}`);

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

    const nimbusConfig = parseNimbusConfig(files);
    const isNextWorkers = isNextWorkersConfig(nimbusConfig);
    const isWorkersTarget = nimbusConfig?.target === 'workers' && !isNextWorkers;

    if (isNextWorkers) {
      const wranglerConfig = buildWranglerConfig(jobId);
      await sandbox.writeFile(`${APP_DIR}/${PROJECT_WRANGLER_FILENAME}`, wranglerConfig);
      await sandbox.writeFile(`${APP_DIR}/${NIMBUS_WRANGLER_FILENAME}`, wranglerConfig);
    }

    // Check if this is a Node.js project (has package.json)
    const hasPackageJson = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));

    let installDurationMs = 0;
    let buildDurationMs = 0;

    if (hasPackageJson) {
      // Step 3: Install dependencies using bun (much faster than npm)
      sendEvent({ type: 'installing' });
      const stopInstallHeartbeat = startHeartbeat(sendEvent, 'installing');
      const stopInstallLogs = startLogStreamer(sandbox, sendEvent, INSTALL_LOG_PATH, 'install');
      const installStart = Date.now();

      // Use bun install - it's 10-100x faster than npm
      const bunInstallCommand = wrapWithTimeout('bun install --no-save', INSTALL_TIMEOUT);
      let installResult = await sandbox.exec(
        `cd ${APP_DIR} && ${bunInstallCommand} > "${INSTALL_LOG_PATH}" 2>&1`,
        {
          timeout: INSTALL_TIMEOUT,
        }
      );

      try {
        installDurationMs = Date.now() - installStart;

        if (installResult.exitCode !== 0) {
          const logTail = await readLogTail(sandbox, INSTALL_LOG_PATH);
          throw new Error(
            ensureLogSection(`Install failed (exit ${installResult.exitCode}).`, 'install log', logTail)
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const logTail = await readLogTail(sandbox, INSTALL_LOG_PATH);
        throw new Error(ensureLogSection(message, 'install log', logTail));
      } finally {
        stopInstallLogs();
        stopInstallHeartbeat();
      }

      // Step 4: Build if there's a build script
      sendEvent({ type: 'building' });
      const packageJsonFile = files.find(f => f.path === 'package.json');
      const hasBuildScript = packageJsonFile && packageJsonFile.content.includes('"build"');

      if (hasBuildScript) {
        const buildStart = Date.now();
        const nextBuildEnv =
          'CI=true NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_DISABLE_ESLINT=1 NODE_OPTIONS="--trace-warnings --trace-deprecation"';
        const openNextEnv = `${nextBuildEnv} DEBUG="opennextjs*"`;
        const stopBuildHeartbeat = startHeartbeat(sendEvent, 'building');
        const stopBuildLogs = startLogStreamer(sandbox, sendEvent, BUILD_LOG_PATH, 'build');
        try {
          let buildResult: { exitCode: number; stdout: string; stderr: string } | null = null;
          if (isNextWorkers) {
            const nextBuildCommand = `cd ${APP_DIR} && ${nextBuildEnv} ${wrapWithTimeout(
              'bunx next build',
              NEXTJS_BUILD_TIMEOUT
            )} > "${BUILD_LOG_PATH}" 2>&1`;
            const nextBuildResult = await execWithTimeout(sandbox, nextBuildCommand, NEXTJS_BUILD_TIMEOUT);
            buildResult = nextBuildResult;
            if (nextBuildResult.exitCode !== 0) {
              const logTail = await readLogTail(sandbox, BUILD_LOG_PATH);
              throw new Error(
                ensureLogSection(`Next.js build failed (exit ${nextBuildResult.exitCode}).`, 'build log', logTail)
              );
            }

            const standaloneCheck = await sandbox.exec(
              `test -f ${APP_DIR}/.next/standalone/.next/server/pages-manifest.json && echo "yes" || echo "no"`
            );
            if (standaloneCheck.stdout?.trim() !== 'yes') {
              const logTail = await readLogTail(sandbox, BUILD_LOG_PATH);
              throw new Error(
                ensureLogSection(
                  'Next.js standalone output missing. Ensure next.config sets output="standalone" and avoid experimental.runtime.',
                  'build log',
                  logTail
                )
              );
            }

            await sandbox.exec(`printf "\\n--- opennext build ---\\n" >> "${BUILD_LOG_PATH}"`);

            const openNextCommand = `cd ${APP_DIR} && ${openNextEnv} ${wrapWithTimeout(
              `bunx opennextjs-cloudflare build --skipNextBuild --skipWranglerConfigCheck --noMinify --config=${PROJECT_WRANGLER_FILENAME}`,
              OPENNEXT_BUILD_TIMEOUT
            )} >> "${BUILD_LOG_PATH}" 2>&1`;
            const openNextResult = await execWithTimeout(
              sandbox,
              openNextCommand,
              OPENNEXT_BUILD_TIMEOUT
            );
            buildResult = openNextResult;
          } else {
            const buildCommand = `cd ${APP_DIR} && CI=true ${wrapWithTimeout(
              'bun run build',
              BUILD_TIMEOUT
            )} > "${BUILD_LOG_PATH}" 2>&1`;
            buildResult = await execWithTimeout(sandbox, buildCommand, BUILD_TIMEOUT);
          }

          buildDurationMs = Date.now() - buildStart;

          if (buildResult && buildResult.exitCode !== 0) {
            const logTail = await readLogTail(sandbox, BUILD_LOG_PATH);
            throw new Error(
              ensureLogSection(`Build failed (exit ${buildResult.exitCode}).`, 'build log', logTail)
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const logTail = await readLogTail(sandbox, BUILD_LOG_PATH);
          throw new Error(ensureLogSection(message, 'build log', logTail));
        } finally {
          stopBuildLogs();
          stopBuildHeartbeat();
        }
      }
    } else {
      // Static HTML/CSS project - no build needed
      sendEvent({ type: 'installing' });
      sendEvent({ type: 'building' });
    }

    if (isNextWorkers) {
      const workerEntryCheck = await sandbox.exec(
        `test -f ${APP_DIR}/.open-next/worker.js && echo "yes" || echo "no"`
      );
      if (workerEntryCheck.stdout?.trim() !== 'yes') {
        throw new Error('Next.js SSR output missing: .open-next/worker.js not found');
      }

      const assetsCheck = await sandbox.exec(
        `test -d ${APP_DIR}/.open-next/assets && echo "yes" || echo "no"`
      );
      if (assetsCheck.stdout?.trim() !== 'yes') {
        throw new Error('Next.js SSR output missing: .open-next/assets not found');
      }
    } else if (isWorkersTarget) {
      const workerEntry = nimbusConfig?.workerEntry;
      if (!workerEntry) {
        throw new Error('Workers target requires workerEntry in nimbus.config.json');
      }
      const workerEntryCheck = await sandbox.exec(
        `test -f "${APP_DIR}/${workerEntry}" && echo "yes" || echo "no"`
      );
      if (workerEntryCheck.stdout?.trim() !== 'yes') {
        throw new Error(`Workers output missing: ${workerEntry} not found`);
      }

      const assetsDir = nimbusConfig?.assetsDir;
      if (assetsDir) {
        const assetsCheck = await sandbox.exec(
          `test -d "${APP_DIR}/${assetsDir}" && echo "yes" || echo "no"`
        );
        if (assetsCheck.stdout?.trim() !== 'yes') {
          throw new Error(`Workers output missing: ${assetsDir} not found`);
        }
        await ensureAssetsIgnore(sandbox, assetsDir);
      }

      const wranglerConfig = buildWorkerWranglerConfig(jobId, workerEntry, assetsDir);
      await sandbox.writeFile(`${APP_DIR}/${NIMBUS_WRANGLER_FILENAME}`, wranglerConfig);
    } else {
      const assetsDir = await resolveStaticAssetsDir(sandbox, nimbusConfig);
      const workerEntry = resolveStaticWorkerEntry(files, nimbusConfig);
      if (workerEntry.contents) {
        const workerPath = `${APP_DIR}/${workerEntry.path}`;
        const workerDir = workerPath.substring(0, workerPath.lastIndexOf('/'));
        if (workerDir && workerDir !== APP_DIR) {
          await sandbox.exec(`mkdir -p ${workerDir}`);
        }
        await sandbox.writeFile(workerPath, workerEntry.contents);
      }

      const wranglerConfig = buildWorkerWranglerConfig(jobId, workerEntry.path, assetsDir);
      await sandbox.writeFile(`${APP_DIR}/${NIMBUS_WRANGLER_FILENAME}`, wranglerConfig);
    }

    return {
      sandboxId,
      installDurationMs,
      buildDurationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxBuildError(message, sandboxId);
  }
}
