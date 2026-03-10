import type { Env } from '../types.js';
import { loadRuntimeFlags } from '../lib/flags.js';
import {
  createWorkspaceDeployProvider,
  getWorkspaceDeployProviderConfigError,
  getWorkspaceDeployProviderName,
  normalizeProviderError,
} from '../lib/workspace-deploy-provider.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function getTableColumns(env: Env, tableName: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all<Record<string, unknown>>();
  const rows = Array.isArray(result.results) ? result.results : [];
  return rows
    .map((row) => (typeof row.name === 'string' ? row.name : null))
    .filter((value): value is string => Boolean(value));
}

async function tableExists(env: Env, tableName: string): Promise<boolean> {
  const record = await env.DB.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1')
    .bind('table', tableName)
    .first<{ name: string }>();
  return Boolean(record?.name);
}

export async function handleGetDeployReadiness(env: Env): Promise<Response> {
  const checks: Array<{ code: string; ok: boolean; details?: string }> = [];

  checks.push({
    code: 'queue_binding_workspace_deploys',
    ok: Boolean(env.WORKSPACE_DEPLOYS_QUEUE),
    details: env.WORKSPACE_DEPLOYS_QUEUE ? 'binding detected' : 'WORKSPACE_DEPLOYS_QUEUE binding missing',
  });

  const deploymentsColumns = await getTableColumns(env, 'workspace_deployments');
  const requiredDeploymentColumns = [
    'toolchain_json',
    'dependency_cache_key',
    'dependency_cache_hit',
    'remediations_json',
  ];
  const missingDeploymentColumns = requiredDeploymentColumns.filter((column) => !deploymentsColumns.includes(column));
  checks.push({
    code: 'migration_workspace_deployments_0008',
    ok: missingDeploymentColumns.length === 0,
    details:
      missingDeploymentColumns.length === 0
        ? 'all phase 6 columns present'
        : `missing columns: ${missingDeploymentColumns.join(', ')}`,
  });

  const dependencyCacheTableExists = await tableExists(env, 'workspace_dependency_caches');
  checks.push({
    code: 'migration_workspace_dependency_caches_0008',
    ok: dependencyCacheTableExists,
    details: dependencyCacheTableExists ? 'table exists' : 'workspace_dependency_caches table is missing',
  });

  const flags = await loadRuntimeFlags(env);
  checks.push({
    code: 'runtime_flag_workspace_deploy_enabled',
    ok: flags.workspaceDeployEnabled,
    details: flags.workspaceDeployEnabled ? 'enabled' : 'disabled',
  });

  const providerConfigError = getWorkspaceDeployProviderConfigError(env);
  if (providerConfigError) {
    checks.push({ code: 'workspace_deploy_provider', ok: false, details: providerConfigError });
    return jsonResponse({
      ok: checks.every((check) => check.ok),
      checks,
    });
  }

  const provider = getWorkspaceDeployProviderName(undefined, env);
  checks.push({ code: 'workspace_deploy_provider', ok: true, details: provider });
  try {
    const providerChecks = await createWorkspaceDeployProvider(provider, env).precheck();
    checks.push(...providerChecks);
  } catch (error) {
    const providerError = normalizeProviderError(error);
    checks.push({ code: providerError.code, ok: false, details: providerError.message });
  }

  return jsonResponse({
    ok: checks.every((check) => check.ok),
    checks,
  });
}
