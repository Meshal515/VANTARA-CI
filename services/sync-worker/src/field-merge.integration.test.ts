import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import { sqliteEnv } from './test-d1.ts';
import type { Env } from './types.ts';

const SECRET = 'field-merge-secret-that-is-at-least-32-chars';
const USER = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';

function fieldMergeEnv() {
  return sqliteEnv({
    VANTARA_SESSION_SECRET: SECRET,
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
  });
}

async function postPatches(
  env: Env,
  kind: 'profile.patch' | 'settings.patch',
  ops: Array<{ opId: string; fields: Record<string, unknown> }>,
): Promise<Response> {
  const token = await mintToken(USER, SECRET);
  return worker.fetch(
    new Request('https://worker.test/v1/ops', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ops: ops.map((op) => ({ opId: op.opId, kind, payload: { fields: op.fields } })),
      }),
    }),
    env,
    { waitUntil: () => {} },
  );
}

describe('field merge delivery guarantees', () => {
  it('does not let a retried older profile op overwrite a newer value', async () => {
    const { env, db } = fieldMergeEnv();
    await postPatches(env, 'profile.patch', [{ opId: 'old-op', fields: { displayName: 'قديم' } }]);
    await postPatches(env, 'profile.patch', [{ opId: 'new-op', fields: { displayName: 'جديد' } }]);
    const retry = await postPatches(env, 'profile.patch', [
      { opId: 'old-op', fields: { displayName: 'قديم' } },
    ]);

    expect(retry.status).toBe(200);
    const row = db.prepare('SELECT display_name FROM profiles WHERE user_id = ?').get(USER) as {
      display_name: string;
    };
    expect(row.display_name).toBe('جديد');
  });

  it('applies later overlapping profile patches from the same request', async () => {
    const { env, db } = fieldMergeEnv();
    const response = await postPatches(env, 'profile.patch', [
      { opId: 'first-op', fields: { displayName: 'الأول', bio: 'نبذة' } },
      { opId: 'second-op', fields: { displayName: 'الثاني' } },
    ]);

    expect(response.status).toBe(200);
    const row = db.prepare('SELECT display_name, bio FROM profiles WHERE user_id = ?').get(USER) as {
      display_name: string;
      bio: string;
    };
    expect(row).toEqual({ display_name: 'الثاني', bio: 'نبذة' });
  });

  it('keeps a newer settings value when an older op is retried', async () => {
    const { env, db } = fieldMergeEnv();
    await postPatches(env, 'settings.patch', [{ opId: 'settings-old', fields: { readerMode: 'old' } }]);
    await postPatches(env, 'settings.patch', [{ opId: 'settings-new', fields: { readerMode: 'new' } }]);
    await postPatches(env, 'settings.patch', [{ opId: 'settings-old', fields: { readerMode: 'old' } }]);

    const row = db.prepare('SELECT data FROM settings WHERE user_id = ?').get(USER) as { data: string };
    expect(JSON.parse(row.data)).toMatchObject({ readerMode: 'new' });
  });
});
