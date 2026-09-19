import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyIdentityToken } from '@vantara/domain';
import { UchiyomiClient } from '@vantara/uchiyomi';
import type { Config } from './config.ts';
import { deriveKey } from './crypto.ts';
import { SESSION_COOKIE, SessionStore, type Session } from './sessions.ts';

export interface AppContext {
  config: Config;
  uchiyomi: UchiyomiClient;
  sessions: SessionStore;
}

export function buildContext(config: Config): AppContext {
  const uchiyomi = new UchiyomiClient({
    baseUrl: config.UCHIYOMI_URL,
    ...(config.UCHIYOMI_SERVICE_TOKEN !== undefined
      ? { serviceToken: config.UCHIYOMI_SERVICE_TOKEN }
      : {}),
  });

  const sessions = new SessionStore({
    key: deriveKey(config.SESSION_SECRET, 'session-token'),
    ttlDays: config.SESSION_TTL_DAYS,
    uchiyomi,
  });

  return { config, uchiyomi, sessions };
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    /** B10: خيط التتبّع بين هذا الطلب وسطر سجلّه وبلاغ المستخدم عنه. */
    correlationId: string;
  }
}

function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * B2 يقبل نفس access token v2 الذي يصدره Sync Worker. الكوكي القديم يبقى
 * fallback مؤقتًا حتى B3 كي لا نكسر النقل الحالي أثناء تغيير الهوية.
 */
export function requireSession(ctx: AppContext) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bearer = bearerFrom(request);
    if (bearer) {
      const claims = await verifyIdentityToken(bearer, ctx.config.VANTARA_IDENTITY_SECRET);
      if (claims) {
        const session = await ctx.sessions.resolveIdentity(claims.userId, claims.deviceId);
        if (session) {
          request.session = session;
          return;
        }
      }
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const cookie = request.cookies[SESSION_COOKIE];
    if (!cookie) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const session = await ctx.sessions.resolve(cookie);
    if (!session) {
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    request.session = session;
    void ctx.sessions.touch(session.id).catch(() => {});
  };
}

/** الجلسة بعد أن ضمنها requireSession. يرمي إن استُخدم بلا الحارس. */
export function sessionOf(request: FastifyRequest): Session {
  const session = request.session;
  if (!session) throw new Error('route is missing the requireSession guard');
  return session;
}

export { SESSION_COOKIE };
