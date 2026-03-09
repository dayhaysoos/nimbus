import type {
  WorkspacePackageManager,
  WorkspaceToolchainDetectedFrom,
  WorkspaceToolchainProfile,
} from '../types.js';
import { normalizeProjectRoot as normalizeCheckpointProjectRoot } from './checkpoint-plan.js';

const WORKSPACE_ROOT = '/workspace';

interface SandboxClient {
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
}

export interface RawWorkspaceToolchainSignals {
  packageManager: string | null;
  scripts: Record<string, unknown>;
  lockfiles: {
    pnpm: string | null;
    yarn: string | null;
    npm: string | null;
  };
  projectRoot: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeProjectRoot(value: string): string {
  return normalizeCheckpointProjectRoot(value);
}

function parseManagerFromValue(value: unknown): WorkspacePackageManager | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value === 'pnpm' || value === 'yarn' || value === 'npm') {
    return value;
  }
  return null;
}

export function parsePackageManagerSpec(raw: string | null): {
  manager: WorkspacePackageManager;
  version: string | null;
} | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const at = trimmed.indexOf('@');
  const name = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const manager = parseManagerFromValue(name);
  if (!manager) {
    return null;
  }

  if (at < 0 || at === trimmed.length - 1) {
    return { manager, version: null };
  }

  return { manager, version: trimmed.slice(at + 1) };
}

export function deriveWorkspaceToolchainProfile(signals: RawWorkspaceToolchainSignals): WorkspaceToolchainProfile {
  const projectRoot = normalizeProjectRoot(signals.projectRoot);
  const packageSpec = parsePackageManagerSpec(signals.packageManager);

  if (packageSpec) {
    return {
      manager: packageSpec.manager,
      version: packageSpec.version,
      detectedFrom: 'packageManager',
      projectRoot,
      lockfile: resolveLockfile(signals, packageSpec.manager),
    };
  }

  if (signals.lockfiles.pnpm) {
    return {
      manager: 'pnpm',
      version: null,
      detectedFrom: 'lockfile',
      projectRoot,
      lockfile: { name: 'pnpm-lock.yaml', sha256: signals.lockfiles.pnpm },
    };
  }
  if (signals.lockfiles.yarn) {
    return {
      manager: 'yarn',
      version: null,
      detectedFrom: 'lockfile',
      projectRoot,
      lockfile: { name: 'yarn.lock', sha256: signals.lockfiles.yarn },
    };
  }
  if (signals.lockfiles.npm) {
    return {
      manager: 'npm',
      version: null,
      detectedFrom: 'lockfile',
      projectRoot,
      lockfile: { name: 'package-lock.json', sha256: signals.lockfiles.npm },
    };
  }

  const scriptsText = Object.values(signals.scripts)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();

  if (/\bpnpm\b/.test(scriptsText)) {
    return { manager: 'pnpm', version: null, detectedFrom: 'scripts', projectRoot, lockfile: null };
  }
  if (/\byarn\b/.test(scriptsText)) {
    return { manager: 'yarn', version: null, detectedFrom: 'scripts', projectRoot, lockfile: null };
  }
  if (/\bnpm\b/.test(scriptsText)) {
    return { manager: 'npm', version: null, detectedFrom: 'scripts', projectRoot, lockfile: null };
  }

  return { manager: 'npm', version: null, detectedFrom: 'fallback', projectRoot, lockfile: null };
}

function resolveLockfile(
  signals: RawWorkspaceToolchainSignals,
  manager: WorkspacePackageManager
): WorkspaceToolchainProfile['lockfile'] {
  if (manager === 'pnpm' && signals.lockfiles.pnpm) {
    return { name: 'pnpm-lock.yaml', sha256: signals.lockfiles.pnpm };
  }
  if (manager === 'yarn' && signals.lockfiles.yarn) {
    return { name: 'yarn.lock', sha256: signals.lockfiles.yarn };
  }
  if (manager === 'npm' && signals.lockfiles.npm) {
    return { name: 'package-lock.json', sha256: signals.lockfiles.npm };
  }
  return null;
}

export async function detectWorkspaceToolchainProfile(
  sandbox: SandboxClient,
  projectRoot = '.'
): Promise<WorkspaceToolchainProfile> {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const output = await sandbox.exec(
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && python3 - <<'PY'\n# nimbus_detect_toolchain\nimport hashlib\nimport json\nimport os\n\nproject_root = ${JSON.stringify(normalizedRoot)}\nroot_path = os.path.join(os.getcwd(), project_root) if project_root != '.' else os.getcwd()\npackage_json_path = os.path.join(root_path, 'package.json')\npackage_manager = None\nscripts = {}\nif os.path.exists(package_json_path):\n    try:\n        with open(package_json_path, 'r', encoding='utf-8') as f:\n            parsed = json.load(f)\n        if isinstance(parsed, dict):\n            value = parsed.get('packageManager')\n            if isinstance(value, str):\n                package_manager = value\n            maybe_scripts = parsed.get('scripts')\n            if isinstance(maybe_scripts, dict):\n                scripts = maybe_scripts\n    except Exception:\n        scripts = {}\n\ndef lock_hash(name):\n    path = os.path.join(root_path, name)\n    if not os.path.exists(path):\n        return None\n    digest = hashlib.sha256()\n    with open(path, 'rb') as f:\n        while True:\n            chunk = f.read(1024 * 128)\n            if not chunk:\n                break\n            digest.update(chunk)\n    return digest.hexdigest()\n\nprint(json.dumps({\n    'packageManager': package_manager,\n    'scripts': scripts,\n    'lockfiles': {\n        'pnpm': lock_hash('pnpm-lock.yaml'),\n        'yarn': lock_hash('yarn.lock'),\n        'npm': lock_hash('package-lock.json'),\n    },\n    'projectRoot': project_root,\n}))\nPY`,
    { timeout: 30_000 }
  );

  if (output.exitCode !== 0) {
    const combined = [output.stdout, output.stderr].filter(Boolean).join('\n');
    throw new Error(combined || 'Toolchain detection command failed');
  }

  const parsed = JSON.parse(output.stdout) as RawWorkspaceToolchainSignals;
  return deriveWorkspaceToolchainProfile(parsed);
}

export function applyRequestedToolchainOverride(
  detected: WorkspaceToolchainProfile,
  requested: { manager?: unknown; version?: unknown } | null
): WorkspaceToolchainProfile {
  if (!requested || typeof requested !== 'object') {
    return detected;
  }

  const manager = parseManagerFromValue(requested.manager);
  const version = typeof requested.version === 'string' && requested.version.trim() ? requested.version.trim() : null;
  if (!manager) {
    return detected;
  }

  return {
    ...detected,
    manager,
    version,
    detectedFrom: 'request' satisfies WorkspaceToolchainDetectedFrom,
    lockfile:
      detected.lockfile &&
      ((manager === 'pnpm' && detected.lockfile.name === 'pnpm-lock.yaml') ||
        (manager === 'yarn' && detected.lockfile.name === 'yarn.lock') ||
        (manager === 'npm' && detected.lockfile.name === 'package-lock.json'))
        ? detected.lockfile
        : null,
  };
}
