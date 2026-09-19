import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import { sqliteEnv } from './test-d1.ts';
import type { Env } from './types.ts';

const SECRET = 'sync-privacy-secret-that-is-at-least-32-chars';
const VIEWER = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';
const OTHER = 'bedcf897-a6f0-4730-b757-402b14891ca5';

function testEnv() {
  return sqliteEnv({
    VANTARA_SESSION_SECRET: SECRET,
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
  });
}

async function pull(env: Env): Promise<{
  settings?: Array<{ user_id: string; data: string }>;
  notifications?: Array<{ user_id: string; body: string | null }>;
}> {
  const token = await mintToken(VIEWER, SECRET);
  const response = await worker.fetch(
    new Request('https://worker.test/v1/sync?since=0', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
    { waitUntil: () => {} },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { changes: Record<string, unknown[]> };
  return body.changes as {
    settings?: Array<{ user_id: string; data: string }>;
    notifications?: Array<{ user_id: string; body: string | null }>;
  };
}

describe('sync privacy boundaries', () => {
  it('never sends another account settings or notifications to the viewer device', async () => {
    const { env, db } = testEnv();

    db.prepare('UPDATE settings SET data = ?, rev = 5 WHERE user_id = ?')
      .run(JSON.stringify({ privatePreference: 'other-secret' }), OTHER);
    db.prepare('UPDATE settings SET data = ?, rev = 6 WHERE user_id = ?')
      .run(JSON.stringify({ privatePreference: 'viewer-value' }), VIEWER);

    db.prepare(
      `INSERT INTO notifications
         (id, user_id, kind, actor_id, series_ref, body, link, read, seen, created_at, rev)
       VALUES (?, ?, 'SYSTEM', NULL, NULL, ?, NULL, 0, 0, ?, ?)`,
    ).run('other-notification', OTHER, 'خاص بالحساب الآخر', 5, 5);
    db.prepare(
      `INSERT INTO notifications
         (id, user_id, kind, actor_id, series_ref, body, link, read, seen, created_at, rev)
       VALUES (?, ?, 'SYSTEM', NULL, NULL, ?, NULL, 0, 0, ?, ?)`,
    ).run('viewer-notification', VIEWER, 'خاص بالمشاهد', 6, 6);

    db.prepare('UPDATE sync_state SET rev = 6 WHERE id = 1').run();

    const changes = await pull(env);

    expect(changes.settings?.map((row) => row.user_id)).toEqual([VIEWER]);
    expect(changes.notifications?.map((row) => row.user_id)).toEqual([VIEWER]);
    expect(JSON.stringify(changes)).not.toContain('other-secret');
    expect(JSON.stringify(changes)).not.toContain('خاص بالحساب الآخر');
  });
});
