import { describe, expect, it } from 'vitest';
import worker from './index.ts';
import { mintToken } from './session.ts';
import { sqliteEnv } from './test-d1.ts';
import type { Env } from './types.ts';

const SECRET = 'sync-privacy-secret-that-is-at-least-32-chars';
const VIEWER = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';
const OTHER = 'bedcf897-a6f0-4730-b757-402b14891ca5';
const THIRD = '07588797-a471-44d1-99ce-7fb4f188c196';

function testEnv() {
  return sqliteEnv({
    VANTARA_SESSION_SECRET: SECRET,
    VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only-32-chars-x',
  });
}

async function pull(env: Env): Promise<Record<string, Array<Record<string, unknown>>>> {
  const token = await mintToken(VIEWER, SECRET);
  const response = await worker.fetch(
    new Request('https://worker.test/v1/sync?since=0', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
    { waitUntil: () => {} },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    changes: Record<string, Array<Record<string, unknown>>>;
  };
  return body.changes;
}

function ids(rows: Array<Record<string, unknown>> | undefined, key: string): string[] {
  return (rows ?? []).map((row) => String(row[key])).sort();
}

describe('sync privacy boundaries', () => {
  it('keeps self-owned rows and directed social state away from unrelated devices', async () => {
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

    for (const [userId, suffix, rev] of [
      [OTHER, 'other', 7],
      [VIEWER, 'viewer', 8],
    ] as const) {
      db.prepare(
        `INSERT INTO library
           (user_id, series_ref, series_title, cover_url, source_id, added_at, removed, rev)
         VALUES (?, ?, ?, NULL, NULL, ?, 0, ?)`,
      ).run(userId, `series-${suffix}`, `Series ${suffix}`, rev, rev);

      db.prepare(
        `INSERT INTO progress
           (user_id, chapter_key, series_ref, page, ratio, updated_at, rev, owner_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(userId, `chapter-${suffix}`, `series-${suffix}`, rev, 0.5, rev, rev);

      db.prepare(
        `INSERT INTO collections
           (user_id, kind, series_ref, member, position, updated_at, rev)
         VALUES (?, 'favorite', ?, 1, NULL, ?, ?)`,
      ).run(userId, `favorite-${suffix}`, rev, rev);
    }

    const insertRecommendation = db.prepare(
      `INSERT INTO recommendations
         (id, from_id, to_id, series_ref, series_title, cover_url, message, state, created_at, rev)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'SENT', ?, ?)`,
    );
    insertRecommendation.run(
      'rec-to-viewer',
      OTHER,
      VIEWER,
      'series-a',
      'A',
      'message-for-viewer',
      10,
      10,
    );
    insertRecommendation.run(
      'rec-from-viewer',
      VIEWER,
      OTHER,
      'series-b',
      'B',
      'message-from-viewer',
      11,
      11,
    );
    insertRecommendation.run(
      'rec-other-third',
      OTHER,
      THIRD,
      'series-c',
      'C',
      'third-only-secret',
      12,
      12,
    );
    insertRecommendation.run(
      'rec-broadcast',
      OTHER,
      null,
      'series-d',
      'D',
      'broadcast-message',
      13,
      13,
    );

    const insertRecipient = db.prepare(
      `INSERT INTO recommendation_recipients
         (recommendation_id, user_id, state, intent, responded_at, rev)
       VALUES (?, ?, 'PENDING', NULL, NULL, ?)`,
    );
    insertRecipient.run('rec-to-viewer', VIEWER, 10);
    insertRecipient.run('rec-from-viewer', OTHER, 11);
    insertRecipient.run('rec-other-third', THIRD, 12);
    insertRecipient.run('rec-broadcast', VIEWER, 13);
    insertRecipient.run('rec-broadcast', THIRD, 13);

    const insertActivity = db.prepare(
      `INSERT INTO activity
         (id, actor_id, verb, series_ref, payload, created_at, rev, target_user_id, link)
       VALUES (?, ?, 'RECOMMENDATION', ?, ?, ?, ?, ?, NULL)`,
    );
    insertActivity.run(
      'event-to-viewer',
      OTHER,
      'series-a',
      JSON.stringify({ message: 'activity-for-viewer' }),
      14,
      14,
      VIEWER,
    );
    insertActivity.run(
      'event-to-third',
      OTHER,
      'series-c',
      JSON.stringify({ message: 'activity-third-only' }),
      15,
      15,
      THIRD,
    );
    insertActivity.run(
      'event-public',
      OTHER,
      'series-public',
      '{}',
      16,
      16,
      null,
    );
    insertActivity.run(
      'event-from-viewer',
      VIEWER,
      'series-own',
      '{}',
      17,
      17,
      THIRD,
    );

    const insertReceipt = db.prepare(
      `INSERT INTO activity_receipts
         (event_id, user_id, delivered_at, seen_at, rev)
       VALUES (?, ?, NULL, NULL, ?)`,
    );
    insertReceipt.run('event-to-viewer', VIEWER, 14);
    insertReceipt.run('event-public', VIEWER, 16);
    insertReceipt.run('event-public', THIRD, 16);
    insertReceipt.run('event-from-viewer', OTHER, 17);
    insertReceipt.run('event-from-viewer', THIRD, 17);

    db.prepare('UPDATE sync_state SET rev = 20 WHERE id = 1').run();

    const changes = await pull(env);

    expect(ids(changes['settings'], 'user_id')).toEqual([VIEWER]);
    expect(ids(changes['notifications'], 'user_id')).toEqual([VIEWER]);
    expect(ids(changes['library'], 'user_id')).toEqual([VIEWER]);
    expect(ids(changes['progress'], 'user_id')).toEqual([VIEWER]);
    expect(ids(changes['collections'], 'user_id')).toEqual([VIEWER]);

    expect(ids(changes['recommendations'], 'id')).toEqual([
      'rec-broadcast',
      'rec-from-viewer',
      'rec-to-viewer',
    ]);
    expect(
      (changes['recommendation_recipients'] ?? [])
        .map((row) => `${String(row['recommendation_id'])}:${String(row['user_id'])}`)
        .sort(),
    ).toEqual([
      `rec-broadcast:${VIEWER}`,
      `rec-from-viewer:${OTHER}`,
      `rec-to-viewer:${VIEWER}`,
    ]);

    expect(ids(changes['activity'], 'id')).toEqual([
      'event-from-viewer',
      'event-public',
      'event-to-viewer',
    ]);
    expect(
      (changes['activity_receipts'] ?? [])
        .map((row) => `${String(row['event_id'])}:${String(row['user_id'])}`)
        .sort(),
    ).toEqual([
      `event-from-viewer:${THIRD}`,
      `event-from-viewer:${OTHER}`,
      `event-public:${VIEWER}`,
      `event-to-viewer:${VIEWER}`,
    ]);

    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain('other-secret');
    expect(serialized).not.toContain('خاص بالحساب الآخر');
    expect(serialized).not.toContain('third-only-secret');
    expect(serialized).not.toContain('activity-third-only');
    expect(serialized).not.toContain('series-other');
    expect(serialized).not.toContain('chapter-other');
    expect(serialized).not.toContain('favorite-other');
  });
});
