/**
 * B11 — تدهور مفهوم عند فشل التبعيات.
 *
 * السؤال هنا ليس «هل يعمل؟» بل: عندما يسقط Uchiyomi أو PostgreSQL، **ماذا
 * يرى المستخدم؟** الجواب المطلوب: خطأ صريح يُميّز عطل المنبع من عطلنا، ولا
 * محتوى ناقص يُسلَّم كأنه كامل، ولا تفصيل داخلي يتسرّب.
 *
 * ما يحتاج بيئة حقيقية (إعادة تشغيل Postgres، إعادة تشغيل Uchiyomi، D1) مسجَّل
 * في `docs/VANTARA_FAILURE_MATRIX.md` كمؤجَّل بصراحة، لا مُدّعى.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@vantara/db', () => ({
  query: vi.fn(async (sql: string) => {
    if (dbDown) throw new Error('connection terminated unexpectedly');
    // فحص الجهوزية يسأل عن وجود الجدول، لا عن صفوف سياسة الحذف. خلطهما كان
    // يجعل `/healthz` يقرأ قائمة فارغة كـ«لا مخطّط» فيرجع 503 دائمًا.
    if (typeof sql === 'string' && sql.includes('to_regclass')) {
      return schemaPresent ? [{ schema: true }] : [{ schema: false }];
    }
    return dbRows;
  }),
  queryOne: vi.fn(async () => {
    if (dbDown) throw new Error('connection terminated unexpectedly');
    return null;
  }),
  transaction: vi.fn(async () => undefined),
  initPool: vi.fn(),
  closePool: vi.fn(async () => undefined),
}));

let dbDown = false;
let dbRows: { series_ref: string }[] = [];
/**
 * هل يرى `/healthz` مخطّطًا مطبَّقًا؟
 *
 * B1 أضاف هذا الفحص لأن `SELECT 1` وحده كان يعطي أخضر فوق قاعدة بلا جداول —
 * أي أن الـAPI يُعلن جهوزيته وهو عاجز عن خدمة أي مسار.
 */
let schemaPresent = true;
let upstreamDown = false;
let upstreamHealthy = true;

const { buildApp } = await import('./app.ts');
const { loadConfig } = await import('./lib/config.ts');
const { SESSION_COOKIE } = await import('./lib/context.ts');

let app: FastifyInstance;
const cookie = `${SESSION_COOKIE}=session-1`;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    UCHIYOMI_URL: 'http://127.0.0.1:1',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    // B2 جعله إلزاميًّا: الـContent API لا يتحقق من توكن الهوية بلا سرّه
    VANTARA_IDENTITY_SECRET: 'test-identity-secret-at-least-32-chars-x',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
  });
  const built = await buildApp(config);
  app = built.app;

  built.ctx.sessions.resolve = async () => ({
    id: 'session-1',
    userId: 'user-1',
    username: 'dahmi',
    token: 'upstream-token',
  });
  built.ctx.sessions.touch = async () => undefined;

  const fail = async () => {
    throw new Error('upstream unavailable');
  };
  built.ctx.uchiyomi.healthy = (async () => upstreamHealthy) as typeof built.ctx.uchiyomi.healthy;
  built.ctx.uchiyomi.librarySearch = (async (...args: unknown[]) => {
    if (upstreamDown) return fail();
    void args;
    return { content: [{ id: 's1', name: 'عمل' }], last: true, totalElements: 1 };
  }) as typeof built.ctx.uchiyomi.librarySearch;
  built.ctx.uchiyomi.listSources = (async () => {
    if (upstreamDown) return fail();
    return [{ id: 'src', name: 'مصدر', lang: 'ar' }];
  }) as typeof built.ctx.uchiyomi.listSources;
  built.ctx.uchiyomi.chapters = (async () => {
    if (upstreamDown) return fail();
    return [];
  }) as typeof built.ctx.uchiyomi.chapters;

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  dbDown = false;
  upstreamDown = false;
});

function healthy() {
  dbDown = false;
  dbRows = [];
  schemaPresent = true;
  upstreamDown = false;
  upstreamHealthy = true;
}

describe('readiness tells the truth about each dependency', () => {
  it('reports both up', async () => {
    healthy();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: true, schema: true, uchiyomi: true });
  });

  it('refuses readiness when the database is up but the schema never ran', async () => {
    // الحالة التي أدخلها B1: اتصال ناجح فوق قاعدة فارغة. `SELECT 1` يمرّ،
    // وكل مسار حقيقي يفشل — فإعلان الجهوزية هنا كذبٌ يخدع المراقبة نفسها.
    healthy();
    schemaPresent = false;
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: true, schema: false });
  });

  it('answers 503 and names which side is down', async () => {
    healthy();
    upstreamHealthy = false;
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    // «التطبيق ما اشتغل» ليست معلومة. أي تبعية سقطت — هذه معلومة.
    expect(res.json()).toMatchObject({ ok: false, db: true, uchiyomi: false });
  });

  it('answers 503 when the database is the side that is down', async () => {
    healthy();
    dbDown = true;
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: false });
  });

  it('keeps liveness answering while everything else is down', async () => {
    healthy();
    dbDown = true;
    upstreamHealthy = false;
    const res = await app.inject({ method: 'GET', url: '/livez' });
    // حياة العملية منفصلة عن جهوزيتها: مُراقب يحتاج التمييز
    expect(res.statusCode).toBe(200);
  });
});

describe('upstream down', () => {
  it('says the upstream failed instead of returning an empty library', async () => {
    healthy();
    upstreamDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('degrades explore section by section rather than failing the screen', async () => {
    healthy();
    upstreamDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/explore', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const sections = res.json().content;
    expect(sections).toHaveLength(4);
    for (const section of sections) {
      expect(section.available).toBe(false);
      expect(section.content).toEqual([]);
    }
  });

  it('reports a failing source list as an upstream fault', async () => {
    healthy();
    upstreamDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/explore/sources', headers: { cookie } });
    expect(res.statusCode).toBe(502);
  });

  it('never leaks the upstream error text to the client', async () => {
    healthy();
    upstreamDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    expect(res.body).not.toMatch(/upstream unavailable|Error:|at async/);
  });
});

describe('database down', () => {
  it('fails closed on a route whose policy it cannot read', async () => {
    // سياسة «الحذف للجميع» تُقرأ من القاعدة. تعذّر قراءتها لا يجوز أن يعني
    // إظهار عمل محذوف: الفشل هنا آمن، لا متساهل.
    healthy();
    dbDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json()).toMatchObject({ error: 'internal_error' });
  });

  it('keeps the internal error text out of the response', async () => {
    healthy();
    dbDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/explore', headers: { cookie } });
    expect(res.body).not.toMatch(/connection terminated|pg|postgres/i);
  });
});

describe('a client asking for something that is not there', () => {
  it('answers 404 for an unknown v1 path, not the app shell', async () => {
    healthy();
    const res = await app.inject({ method: 'GET', url: '/v1/nope', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers 401 without a session even while dependencies are down', async () => {
    healthy();
    dbDown = true;
    upstreamDown = true;
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse' });
    // الحارس يسبق أي تبعية: لا يُستهلك منبع من أجل طلب بلا جلسة
    expect(res.statusCode).toBe(401);
  });
});
