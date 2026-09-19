import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(import.meta.dirname, '../migrations');

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  }
  return db;
}

describe('D1 migrations', () => {
  it('persists top works without losing existing collection kinds', () => {
    const db = migratedDatabase();
    const userId = '9e4b51d9-4ca0-4da2-9b1f-2205e67134ed';

    const insert = db.prepare(
      `INSERT INTO collections
         (user_id, kind, series_ref, member, position, updated_at, rev)
       VALUES (?, ?, ?, 1, ?, 1, 1)`,
    );
    insert.run(userId, 'favorite', 'series:fav', 0);
    insert.run(userId, 'read_later', 'series:later', 1);
    insert.run(userId, 'top', 'series:top', 2);

    const rows = db
      .prepare('SELECT kind, series_ref FROM collections ORDER BY position')
      .all() as Array<{ kind: string; series_ref: string }>;
    expect(rows).toEqual([
      { kind: 'favorite', series_ref: 'series:fav' },
      { kind: 'read_later', series_ref: 'series:later' },
      { kind: 'top', series_ref: 'series:top' },
    ]);
  });
});
