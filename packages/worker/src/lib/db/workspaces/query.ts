import type { WorkspaceResponse } from '../../../types.js';
import { toWorkspaceResponse } from './shared.js';

export async function getWorkspace(db: D1Database, id: string): Promise<WorkspaceResponse | null> {
  const result = await db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first();
  if (!result) {
    return null;
  }
  return toWorkspaceResponse(result as never);
}

export async function getWorkspaceAccountId(db: D1Database, id: string): Promise<string | null | undefined> {
  const result = await db.prepare('SELECT account_id FROM workspaces WHERE id = ?').bind(id).first<{ account_id: string | null }>();
  if (!result) {
    return undefined;
  }
  return result.account_id;
}
