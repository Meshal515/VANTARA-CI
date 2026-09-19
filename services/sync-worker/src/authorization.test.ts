import { describe, expect, it } from 'vitest';
import * as worker from './index.ts';
import type { D1PreparedStatement, Env } from './types.ts';

type Incoming = { opId: string; kind: string; payload: Record<string, unknown> };
type Guard = (
  ops: readonly Incoming[],
  userId: string,
  env: Env,
) => Promise<{ status: 403 | 404; error: 'forbidden' | 'recommendation_not_found' } | null>;

const validateRecommendationResponses = (
  worker as unknown as { validateRecommendationResponses?: Guard }
).validateRecommendationResponses;

interface Query {
  sql: string;
  values: unknown[];
}

function authEnv(rows: Array<{ id: string; recipient_user_id: string | null }>) {
  const queries: Query[] = [];
  const prepare = (sql: string): D1PreparedStatement => {
    const q: Query = { sql, values: [] };
    queries.push(q);
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        q.values = values;
        return statement;
      },
      async first<T = unknown>() {
        return null as T | null;
      },
      async all<T = unknown>() {
        return { results: rows as T[], success: true, meta: {} };
      },
      async run() {
        return { results: [], success: true, meta: {} };
      },
    };
    return statement;
  };

  return {
    queries,
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
      // B2 جعل سرّي الهوية والـpepper إلزاميين في `Env`. بيئة اختبار ناقصة
      // تكذب على زمن التشغيل، فنعطيها ما يعطيه الناشر فعلًا.
      VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only',
      VANTARA_DEVICE_PEPPER: 'device-pepper-for-tests-only',
    } as Env,
  };
}

const respond = (recommendationId: string): Incoming => ({
  opId: `response-${recommendationId}`,
  kind: 'recommendation.respond',
  payload: { recommendationId, state: 'ACCEPTED' },
});

describe('B8 recommendation response authorization', () => {
  it('returns not-found when the recommendation does not exist', async () => {
    expect(typeof validateRecommendationResponses).toBe('function');
    if (!validateRecommendationResponses) return;

    const { env } = authEnv([]);
    await expect(
      validateRecommendationResponses([respond('missing')], 'ngm', env),
    ).resolves.toEqual({ status: 404, error: 'recommendation_not_found' });
  });

  it('returns forbidden when the recommendation exists but the viewer is not a recipient', async () => {
    expect(typeof validateRecommendationResponses).toBe('function');
    if (!validateRecommendationResponses) return;

    const { env } = authEnv([{ id: 'r1', recipient_user_id: null }]);
    await expect(validateRecommendationResponses([respond('r1')], 'ngm', env)).resolves.toEqual({
      status: 403,
      error: 'forbidden',
    });
  });

  it('allows a real recipient', async () => {
    expect(typeof validateRecommendationResponses).toBe('function');
    if (!validateRecommendationResponses) return;

    const { env } = authEnv([{ id: 'r1', recipient_user_id: 'ngm' }]);
    await expect(validateRecommendationResponses([respond('r1')], 'ngm', env)).resolves.toBeNull();
  });

  it('does not query recommendations when the batch has no response operation', async () => {
    expect(typeof validateRecommendationResponses).toBe('function');
    if (!validateRecommendationResponses) return;

    const { env, queries } = authEnv([]);
    await validateRecommendationResponses(
      [{ opId: 'rating-1', kind: 'rating.set', payload: { seriesRef: 's1', score: 9 } }],
      'ngm',
      env,
    );
    expect(queries.some((query) => /FROM recommendations/i.test(query.sql))).toBe(false);
  });
});
