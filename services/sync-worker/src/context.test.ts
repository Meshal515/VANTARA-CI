import { describe, expect, it } from 'vitest';
import * as worker from './index.ts';
import type { D1PreparedStatement, Env } from './types.ts';

type ContextLoader = (
  ops: readonly { opId: string; kind: string; payload: Record<string, unknown> }[],
  env: Env,
) => Promise<{
  accounts: readonly string[];
  comments?: Readonly<Record<string, { authorId: string; seriesRef: string }>>;
}>;

const loadOpContext = (worker as unknown as { loadOpContext?: ContextLoader }).loadOpContext;

interface QueryRecord {
  sql: string;
  values: unknown[];
}

function contextEnv(): { env: Env; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];

  const prepare = (sql: string): D1PreparedStatement => {
    const record: QueryRecord = { sql, values: [] };
    queries.push(record);

    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        record.values = values;
        return statement;
      },
      async first<T = unknown>() {
        return null as T | null;
      },
      async all<T = unknown>() {
        if (/FROM accounts/i.test(sql)) {
          return {
            results: [
              { user_id: 'dahmi' },
              { user_id: 'mansour' },
              { user_id: 'ngm' },
            ] as T[],
            success: true,
            meta: {},
          };
        }

        if (/FROM comments/i.test(sql)) {
          return {
            results: record.values.map((value) => ({
              id: String(value),
              author_id: `author-${String(value)}`,
              series_ref: `series-${String(value)}`,
            })) as T[],
            success: true,
            meta: {},
          };
        }

        return { results: [] as T[], success: true, meta: {} };
      },
      async run() {
        return { results: [], success: true, meta: {} };
      },
    };
    return statement;
  };

  return {
    env: {
      DB: {
        prepare,
        async batch() {
          return [];
        },
        async exec() {
          return { count: 0, duration: 0 };
        },
      },
      VANTARA_SESSION_SECRET: 'test-secret',
      // B2 جعل سرّي الهوية والـpepper إلزاميين في `Env`.
      VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only',
      VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only',
    } as Env,
    queries,
  };
}

describe('B8 op context loading', () => {
  it('loads social accounts and comment metadata in D1-safe chunks', async () => {
    expect(typeof loadOpContext).toBe('function');
    if (!loadOpContext) return;

    const { env, queries } = contextEnv();
    const reactions = Array.from({ length: 95 }, (_, index) => ({
      opId: `op-${index}`,
      kind: 'reaction.set',
      payload: { commentId: `comment-${index}`, emoji: '🔥', active: true },
    }));

    // duplicate reference proves ids are deduplicated before building IN clauses.
    reactions.push({
      opId: 'op-duplicate',
      kind: 'reaction.set',
      payload: { commentId: 'comment-0', emoji: '❤️', active: true },
    });

    const ctx = await loadOpContext(reactions, env);

    expect(ctx.accounts).toEqual(['dahmi', 'mansour', 'ngm']);
    expect(Object.keys(ctx.comments ?? {})).toHaveLength(95);
    expect(ctx.comments?.['comment-94']).toEqual({
      authorId: 'author-comment-94',
      seriesRef: 'series-comment-94',
    });

    const commentQueries = queries.filter((entry) => /FROM comments/i.test(entry.sql));
    expect(commentQueries).toHaveLength(2);
    expect(Math.max(...commentQueries.map((entry) => entry.values.length))).toBeLessThanOrEqual(90);
    expect(commentQueries.flatMap((entry) => entry.values)).toHaveLength(95);
  });

  it('does not query comments when no operation references one', async () => {
    expect(typeof loadOpContext).toBe('function');
    if (!loadOpContext) return;

    const { env, queries } = contextEnv();
    await loadOpContext(
      [{ opId: 'r1', kind: 'rating.set', payload: { seriesRef: 's1', score: 9 } }],
      env,
    );

    expect(queries.some((entry) => /FROM comments/i.test(entry.sql))).toBe(false);
  });
});
