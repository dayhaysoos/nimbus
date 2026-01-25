/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  LOGS_BUCKET: R2Bucket;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

const CLEANUP_LIMIT = 50;

type CleanupJobRecord = {
  id: string;
  worker_name: string | null;
  build_log_key: string | null;
  deploy_log_key: string | null;
};

async function deleteWorker(env: Env, workerName: string): Promise<boolean> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${workerName}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (response.status === 404) {
    return true;
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(`[cleanup] Failed to delete worker ${workerName}:`, text);
    return false;
  }

  const body = (await response.json().catch(() => null)) as { success?: boolean } | null;
  if (body && body.success === false) {
    console.error(`[cleanup] Worker delete returned success=false for ${workerName}`);
    return false;
  }

  return true;
}

async function deleteLogs(env: Env, record: CleanupJobRecord): Promise<void> {
  if (record.build_log_key) {
    await env.LOGS_BUCKET.delete(record.build_log_key);
  }
  if (record.deploy_log_key) {
    await env.LOGS_BUCKET.delete(record.deploy_log_key);
  }
}

async function cleanupExpiredJobs(env: Env): Promise<void> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('[cleanup] Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
    return;
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `SELECT id, worker_name, build_log_key, deploy_log_key
     FROM jobs
     WHERE status IN ('completed', 'failed')
       AND expires_at IS NOT NULL
       AND expires_at <= ?
     LIMIT ?`
  )
    .bind(now, CLEANUP_LIMIT)
    .all<CleanupJobRecord>();

  for (const record of result.results) {
    const workerName = record.worker_name;
    if (workerName) {
      const deleted = await deleteWorker(env, workerName);
      if (!deleted) {
        continue;
      }
    }

    await deleteLogs(env, record);

    await env.DB
      .prepare('UPDATE jobs SET status = ? WHERE id = ?')
      .bind('expired', record.id)
      .run();
  }
}

export default {
  async scheduled(_: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredJobs(env));
  },
};
