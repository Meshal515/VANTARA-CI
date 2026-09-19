import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { D1PreparedStatement, Env } from './types.ts';

interface SqliteStatement extends D1PreparedStatement {
  sql: string;
  values: unknown[];
}

type SqliteValue = string | number | bigint | Uint8Array | null;

export function sqliteEnv(overrides: Partial<Env> = {}): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = join(import.meta.dirname, '../migrations');
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  }

  const prepare = (sql: string): SqliteStatement => {
    let statement: SqliteStatement;
    statement = {
      sql,
      values: [],
      bind(...values: unknown[]) {
        statement.values = values;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...(statement.values as SqliteValue[])) ?? null) as T;
      },
      async all<T>() {
        return {
          results: db.prepare(sql).all(...(statement.values as SqliteValue[])) as T[],
          success: true,
          meta: {},
        };
      },
      async run<T>() {
        db.prepare(sql).run(...(statement.values as SqliteValue[]));
        return { results: [] as T[], success: true, meta: {} };
      },
    } satisfies SqliteStatement;
    return statement;
  };

  const env = {
    DB: {
      prepare,
      async batch(statements: D1PreparedStatement[]) {
        db.exec('BEGIN');
        try {
          for (const raw of statements) {
            const statement = raw as SqliteStatement;
            db.prepare(statement.sql).run(...(statement.values as SqliteValue[]));
          }
          db.exec('COMMIT');
          return [];
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      exec: async (sql: string) => {
        db.exec(sql);
        return { count: 0, duration: 0 };
      },
    },
    ...overrides,
  } as unknown as Env;

  return { env, db };
}
