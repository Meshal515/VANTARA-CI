import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import { sqliteEnv } from './test-d1.ts';
import type { Env } from './types.ts';

const SECRET = 'delta-boundary-secret-that-is-at-least-32-chars';
const USER = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';

function testEnv() {
  return sqliteEnv({
    VANTARA_SESSION_SECRET: SECRET,
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
  });
}

async function pull(env: Env, since: number): Promise<Response> {
  const token = await mintToken(USER, SECRET);
  return worker.fetch(
    new Request(`https://worker.test/v1/sync?since=${String(since)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
    { waitUntil: () => {} },
  );
}

describe('delta pagination revision boundaries', () => {
  it('does not drop rows when the page cap cuts through a shared revision', async () => {
    const { env, db } = testEnv();
    db.prepare('INSERT INTO accounts (user_id, username, created_at, rev) VALUES (?, ?, ?, ?)')
      .run(USER, 'mishal', 1, 1);

    const insert = db.prepare(
      `INSERT INTO activity
         (id, actor_id, verb, series_ref, payload, created_at, rev)
       VALUES (?, ?, 'READ', NULL, '{}', ?, ?)`,
    );

    db.exec('BEGIN');
    try {
      for (let index = 0; index < 599; index++) {
        // 499 rows at rev=10, then 100 rows at rev=11. PAGE_SIZE=500 therefore
        // cuts after the first row of rev=11.
        insert.run(`event-${String(index)}`, USER, index + 1, index < 499 ? 10 : 11);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.prepare('UPDATE sync_state SET rev = 11 WHERE id = 1').run();

    const delivered = new Set<string>();
    let cursor = 0;
    for (let page = 0; page < 3; page++) {
      const response = await pull(env, cursor);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        cursor: number;
        more: boolean;
        changes: { activity?: Array<{ id: string }> };
      };
      for (const row of body.changes.activity ?? []) delivered.add(row.id);
      cursor = body.cursor;
      if (!body.more) break;
    }

    expect(delivered.size).toBe(599);
    expect(cursor).toBe(11);
  });
});
