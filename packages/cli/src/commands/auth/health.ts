import * as p from '@clack/prompts';
import { getAuthExchangeHealth } from '../../clients/worker/auth.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';

export async function authHealthCommand(options?: { json?: boolean }): Promise<void> {
  const workerUrl = getWorkerUrl();
  const health = await getAuthExchangeHealth(workerUrl);

  if (options?.json === true) {
    console.log(JSON.stringify({ workerUrl, ...health }));
    return;
  }

  const status = health.exchangeReady ? 'ready' : 'not_ready';
  p.log.success(`Auth exchange health: ${status}`);
  p.log.message(`Worker URL: ${workerUrl}`);
  p.log.message(`Token secret configured: ${health.tokenSecretConfigured ? 'yes' : 'no'}`);
  p.log.message(`OIDC cache binding configured: ${health.oidcCacheBindingConfigured ? 'yes' : 'no'}`);
  p.log.message(
    `OIDC cache warm: ${health.oidcCacheWarm === null ? 'unknown' : health.oidcCacheWarm ? 'yes' : 'no'}`
  );
  p.log.message(`JWKS cache TTL (seconds): ${health.jwksCacheTtlSeconds}`);
  p.log.message(`Nimbus token TTL (seconds): ${health.tokenTtlSeconds}`);
}
