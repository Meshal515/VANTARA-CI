import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from './lib/context.ts';
import { SESSION_COOKIE } from './lib/context.ts';
import { authRoutes } from './routes/auth.ts';

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cookie);

  const ctx = {
    config: {
      COOKIE_SECURE: false,
      SESSION_TTL_DAYS: 60,
      VANTARA_IDENTITY_SECRET: 'identity-secret-for-tests-only-32-chars',
    },
    sessions: {
      async resolve(id: string) {
        if (id !== 'legacy-session') return undefined;
        return {
          id,
          userId: 'user-1',
          username: 'reader',
          token: 'upstream-token',
        };
      },
      async touch() {},
      async revokeAllFor() {
        throw new Error('upstream unavailable');
      },
    },
  } as unknown as AppContext;

  await authRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('legacy logout-all failure semantics', () => {
  it('clears the dead cookie and reports upstream cleanup failure', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { cookie: `${SESSION_COOKIE}=legacy-session` },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'upstream_unavailable' });

    const cleared = response.cookies.find((entry) => entry.name === SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared?.value ?? '').toBe('');
  });
});
