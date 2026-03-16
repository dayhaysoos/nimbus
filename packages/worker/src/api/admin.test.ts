import { strict as assert } from 'assert';
import { handleCreateAdminApiKey } from './admin.js';
import type { AuthContext } from '../types.js';

function createAuthContext(overrides?: Partial<AuthContext>): AuthContext {
  return {
    accountId: 'acct_admin',
    isAdmin: true,
    isAuthenticated: true,
    isHostedMode: true,
    ...overrides,
  };
}

export async function runAdminApiTests(): Promise<void> {
  {
    const inserts: unknown[][] = [];
    const env = {
      DB: {
        prepare() {
          return {
            bind(...values: unknown[]) {
              inserts.push(values);
              return {
                async run() {
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
    } as never;

    const response = await handleCreateAdminApiKey(
      new Request('https://example.com/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'CI key' }),
      }),
      env,
      createAuthContext({ isHostedMode: true, isAdmin: true })
    );

    assert.equal(response.status, 201);
    const payload = (await response.json()) as {
      key: string;
      accountId: string;
      label: string;
      isAdmin: boolean;
    };
    assert.match(payload.key, /^nmb_live_[a-f0-9]{32}$/);
    assert.match(payload.accountId, /^[0-9a-f-]{36}$/);
    assert.equal(payload.label, 'CI key');
    assert.equal(payload.isAdmin, false);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][2], 'CI key');
    assert.equal(inserts[0][3], 0);
  }

  {
    const env = { DB: { prepare() { throw new Error('should not write'); } } } as never;
    const response = await handleCreateAdminApiKey(
      new Request('https://example.com/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Denied key' }),
      }),
      env,
      createAuthContext({ isHostedMode: true, isAdmin: false })
    );
    assert.equal(response.status, 403);
  }

  {
    const env = { DB: { prepare() { throw new Error('should not write'); } } } as never;
    const response = await handleCreateAdminApiKey(
      new Request('https://example.com/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Self hosted key' }),
      }),
      env,
      createAuthContext({ isHostedMode: false, isAdmin: true })
    );
    assert.equal(response.status, 404);
  }

  {
    const env = { DB: { prepare() { throw new Error('should not write'); } } } as never;
    const response = await handleCreateAdminApiKey(
      new Request('https://example.com/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '   ' }),
      }),
      env,
      createAuthContext({ isHostedMode: true, isAdmin: true })
    );
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: string; code: string };
    assert.equal(payload.code, 'invalid_label');
  }
}
