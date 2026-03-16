import type { AuthContext } from '../types.js';

export function canAccessAccount(authContext: AuthContext, accountId: string | null | undefined): boolean {
  if (!authContext.isHostedMode) {
    return true;
  }
  if (authContext.isAdmin) {
    return true;
  }
  if (!authContext.isAuthenticated) {
    return false;
  }
  return typeof accountId === 'string' && accountId === authContext.accountId;
}
