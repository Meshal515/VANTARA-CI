import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@vantara/db';
import { UchiyomiError } from '@vantara/uchiyomi';
import { SESSION_COOKIE, requireSession, sessionOf, type AppContext } from '../lib/context.ts';

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(512),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.COOKIE_SECURE,
    maxAge: ctx.config.SESSION_TTL_DAYS * 24 * 60 * 60,
  };

  /**
   * بوابة THE ORBIT: من هي الحسابات المتاحة للاختيار.
   *
   * تُرجع الأسماء والصور فقط، بلا أدوار ولا حالة 2FA ولا آخر نشاط — شاشة
   * اختيار حساب لا تحتاج أن تكشف بنية الحسابات لمن لم يسجّل الدخول.
   */
  app.get('/v1/auth/accounts', async (_request, reply) => {
    const rows = await query<{ username: string }>(
      `SELECT username FROM vantara_users ORDER BY first_seen_at`,
    );
    return reply.send({
      content: rows.map((row) => ({
        username: row.username,
        // الملف الشخصي يملكه D1 بعد B4؛ Content API لا يحتفظ بنسخة ثانية.
        displayName: row.username,
        avatar: null,
      })),
    });
  });

  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'bad_request' });
      }

      const device = request.headers['user-agent']?.slice(0, 200);
      try {
        const session = await ctx.sessions.login(
          parsed.data.username,
          parsed.data.password,
          device,
        );
        void reply.setCookie(SESSION_COOKIE, session.id, cookieOptions);
        return reply.send({
          user: { id: session.userId, username: session.username },
        });
      } catch (err) {
        if (err instanceof UchiyomiError && (err.status === 401 || err.status === 403)) {
          // لا نفرّق بين مستخدم غير موجود وكلمة مرور خاطئة
          return reply.code(401).send({ error: 'invalid_credentials' });
        }
        if (err instanceof UchiyomiError && err.status === 429) {
          // حدّ المعدّل عند Uchiyomi يُمرَّر كما هو: 502 يخفي سببًا قابلًا للمعالجة
          return reply.code(429).header('retry-after', '60').send({ error: 'rate_limited' });
        }
        request.log.error({ err }, 'login failed');
        return reply.code(502).send({ error: 'upstream_unavailable' });
      }
    },
  );

  app.post('/v1/auth/logout', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    try {
      await ctx.sessions.logout(session);
    } catch (err) {
      request.log.error({ err }, 'upstream token revoke failed during logout');
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const count = await ctx.sessions.revokeAllFor(sessionOf(request).userId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ revoked: count });
  });

  app.get('/v1/auth/me', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);
    // الحقيقة عن المستخدم عند Uchiyomi، لا عندنا (D-02)
    const user = await ctx.uchiyomi.me(session.token);
    return reply.send({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
  });
}
