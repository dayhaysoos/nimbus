import type { Env, RuntimeFlags } from '../types.js';

export interface RuntimeFlagRow {
  key: string;
  value: string;
}

export const DEFAULT_RUNTIME_FLAGS: RuntimeFlags = {
  v2Enabled: false,
  v2CodeBrowserEnabled: false,
  maxAttempts: 3,
  attemptTimeoutMs: 600000,
  totalTimeoutMs: 1800000,
  idempotencyTtlHours: 24,
  maxRepairCycles: 2,
  lintBlocking: false,
  testBlocking: true,
  safeInstallIgnoreScripts: true,
  autoInstallScriptsFallback: true,
  rawRetentionDays: 30,
  summaryRetentionDays: 180,
  workspaceAgentRuntimeEnabled: false,
  workspaceDeployEnabled: false,
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number }
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  if (options?.min !== undefined && parsed < options.min) {
    return options.min;
  }

  if (options?.max !== undefined && parsed > options.max) {
    return options.max;
  }

  return parsed;
}

function normalizeRuntimeFlags(flags: RuntimeFlags): RuntimeFlags {
  return {
    ...flags,
    totalTimeoutMs: Math.max(flags.totalTimeoutMs, flags.attemptTimeoutMs),
  };
}

export function getRuntimeFlagsFromEnv(env: Env): RuntimeFlags {
  const resolved: RuntimeFlags = {
    v2Enabled: parseBoolean(env.V2_ENABLED, DEFAULT_RUNTIME_FLAGS.v2Enabled),
    v2CodeBrowserEnabled: parseBoolean(
      env.V2_CODE_BROWSER_ENABLED,
      DEFAULT_RUNTIME_FLAGS.v2CodeBrowserEnabled
    ),
    maxAttempts: parseInteger(env.MAX_ATTEMPTS, DEFAULT_RUNTIME_FLAGS.maxAttempts, { min: 1, max: 10 }),
    attemptTimeoutMs: parseInteger(
      env.ATTEMPT_TIMEOUT_MS,
      DEFAULT_RUNTIME_FLAGS.attemptTimeoutMs,
      { min: 60000 }
    ),
    totalTimeoutMs: parseInteger(env.TOTAL_TIMEOUT_MS, DEFAULT_RUNTIME_FLAGS.totalTimeoutMs, {
      min: 60000,
    }),
    idempotencyTtlHours: parseInteger(
      env.IDEMPOTENCY_TTL_HOURS,
      DEFAULT_RUNTIME_FLAGS.idempotencyTtlHours,
      { min: 1, max: 168 }
    ),
    maxRepairCycles: parseInteger(
      env.MAX_REPAIR_CYCLES,
      DEFAULT_RUNTIME_FLAGS.maxRepairCycles,
      { min: 0, max: 10 }
    ),
    lintBlocking: parseBoolean(env.LINT_BLOCKING, DEFAULT_RUNTIME_FLAGS.lintBlocking),
    testBlocking: parseBoolean(env.TEST_BLOCKING, DEFAULT_RUNTIME_FLAGS.testBlocking),
    safeInstallIgnoreScripts: parseBoolean(
      env.SAFE_INSTALL_IGNORE_SCRIPTS,
      DEFAULT_RUNTIME_FLAGS.safeInstallIgnoreScripts
    ),
    autoInstallScriptsFallback: parseBoolean(
      env.AUTO_INSTALL_SCRIPTS_FALLBACK,
      DEFAULT_RUNTIME_FLAGS.autoInstallScriptsFallback
    ),
    rawRetentionDays: parseInteger(
      env.RAW_RETENTION_DAYS,
      DEFAULT_RUNTIME_FLAGS.rawRetentionDays,
      { min: 1 }
    ),
    summaryRetentionDays: parseInteger(
      env.SUMMARY_RETENTION_DAYS,
      DEFAULT_RUNTIME_FLAGS.summaryRetentionDays,
      { min: 1 }
    ),
    workspaceAgentRuntimeEnabled: parseBoolean(
      env.WORKSPACE_AGENT_RUNTIME_ENABLED,
      DEFAULT_RUNTIME_FLAGS.workspaceAgentRuntimeEnabled
    ),
    workspaceDeployEnabled: parseBoolean(env.WORKSPACE_DEPLOY_ENABLED, DEFAULT_RUNTIME_FLAGS.workspaceDeployEnabled),
  };

  return normalizeRuntimeFlags(resolved);
}

export function mergeRuntimeFlagOverrides(
  base: RuntimeFlags,
  rows: RuntimeFlagRow[]
): RuntimeFlags {
  const merged: RuntimeFlags = { ...base };

  for (const row of rows) {
    switch (row.key) {
      case 'v2_enabled':
        merged.v2Enabled = parseBoolean(row.value, merged.v2Enabled);
        break;
      case 'v2_code_browser_enabled':
        merged.v2CodeBrowserEnabled = parseBoolean(row.value, merged.v2CodeBrowserEnabled);
        break;
      case 'max_attempts':
        merged.maxAttempts = parseInteger(row.value, merged.maxAttempts, { min: 1, max: 10 });
        break;
      case 'attempt_timeout_ms':
        merged.attemptTimeoutMs = parseInteger(row.value, merged.attemptTimeoutMs, { min: 60000 });
        break;
      case 'total_timeout_ms':
        merged.totalTimeoutMs = parseInteger(row.value, merged.totalTimeoutMs, { min: 60000 });
        break;
      case 'idempotency_ttl_hours':
        merged.idempotencyTtlHours = parseInteger(row.value, merged.idempotencyTtlHours, {
          min: 1,
          max: 168,
        });
        break;
      case 'max_repair_cycles':
        merged.maxRepairCycles = parseInteger(row.value, merged.maxRepairCycles, {
          min: 0,
          max: 10,
        });
        break;
      case 'lint_blocking':
        merged.lintBlocking = parseBoolean(row.value, merged.lintBlocking);
        break;
      case 'test_blocking':
        merged.testBlocking = parseBoolean(row.value, merged.testBlocking);
        break;
      case 'safe_install_ignore_scripts':
        merged.safeInstallIgnoreScripts = parseBoolean(row.value, merged.safeInstallIgnoreScripts);
        break;
      case 'auto_install_scripts_fallback':
        merged.autoInstallScriptsFallback = parseBoolean(
          row.value,
          merged.autoInstallScriptsFallback
        );
        break;
      case 'raw_retention_days':
        merged.rawRetentionDays = parseInteger(row.value, merged.rawRetentionDays, { min: 1 });
        break;
      case 'summary_retention_days':
        merged.summaryRetentionDays = parseInteger(row.value, merged.summaryRetentionDays, { min: 1 });
        break;
      case 'workspace_agent_runtime_enabled':
        merged.workspaceAgentRuntimeEnabled = parseBoolean(row.value, merged.workspaceAgentRuntimeEnabled);
        break;
      case 'workspace_deploy_enabled':
        merged.workspaceDeployEnabled = parseBoolean(row.value, merged.workspaceDeployEnabled);
        break;
      default:
        break;
    }
  }

  return normalizeRuntimeFlags(merged);
}

export async function loadRuntimeFlags(env: Env): Promise<RuntimeFlags> {
  const fromEnv = getRuntimeFlagsFromEnv(env);

  try {
    const result = await env.DB
      .prepare('SELECT key, value FROM runtime_flags')
      .all<RuntimeFlagRow>();

    return mergeRuntimeFlagOverrides(fromEnv, result.results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[flags] Failed to load runtime overrides, using env defaults: ${message}`);
    return fromEnv;
  }
}
