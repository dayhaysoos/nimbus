import { createMockStudioDataSource } from './mockStudioDataSource';
import { createRealStudioDataSource } from './realStudioDataSource';

export function createStudioDataSource(env: Record<string, string | undefined>) {
  const apiBase = (env.VITE_NIMBUS_API_BASE_URL ?? '').replace(/\/$/, '');
  const mockEnabled = ['1', 'true', 'yes', 'on'].includes((env.VITE_STUDIO_MOCK ?? '').trim().toLowerCase());
  if (mockEnabled) {
    return createMockStudioDataSource(env);
  }
  return createRealStudioDataSource(apiBase);
}
