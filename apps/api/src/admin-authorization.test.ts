import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from './lib/context.ts';
import { reportRoutes } from './routes/reports.ts';
import { sourceRoutes } from './routes/sources.ts';

const SESSION = {
  id: 'legacy-cookie',
  userId: '00000000-0000-0000-0000-000000000001',
  username: 'reader',
  token: 'upstream-reader-token',
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(cookie);

  const ctx = {
    config: {
      VANTARA_IDENTITY_SECRET: 'test-identity-secret-at-least-32-chars-x',
    },
    sessions: {
      async resolve(id: string) {
        return id === SESSION.id ? SESSION : undefined;
      },
      async touch() {},
    },
    uchiyomi: {
      async me() {
        return {
          id: SESSION.userId,
          username: SESSION.username,
          displayName: SESSION.username,
          role: 'user',
        };
      },
    },
  } as unknown as AppContext;

  await reportRoutes(app, ctx);
  await sourceRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const headers = { cookie: `vantara_session=${SESSION.id}` };

describe('operational/admin read authorization', () => {
  for (const url of [
    '/v1/deleted-works',
    '/v1/sources/example/evidence',
    '/v1/sources/example/probes',
  ]) {
    it(`rejects a normal user from GET ${url}`, async () => {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'admin_only' });
    });
  }
});
