/**
 * عقد شاشة المكتبة والاستكشاف، بـupstream مُسجَّل وقاعدة مُقلَّدة.
 *
 * ما يُثبته هذا الملف ليس شكل الجواب فقط، بل **تكلفة** النداء: `GET /v1/library`
 * يمشي كل صفحات المكتبة عند كل فتح، وشاشة بآلاف الأعمال لا تتحمّل ذلك. العدّ
 * هنا هو الدليل، لا التقدير.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@vantara/db', () => ({
  // سياسة الحذف للجميع تُقرأ من مخزن الخادم؛ هنا فارغة إلا حيث يقول الاختبار
  query: vi.fn(async () => deletedRows),
  queryOne: vi.fn(async () => null),
  transaction: vi.fn(async () => undefined),
  initPool: vi.fn(),
  closePool: vi.fn(async () => undefined),
}));

let deletedRows: { series_ref: string }[] = [];

const { buildApp } = await import('./app.ts');
const { loadConfig } = await import('./lib/config.ts');
const { SESSION_COOKIE } = await import('./lib/context.ts');

let app: FastifyInstance;
let calls: { page?: number; size?: number; sort?: string; query?: string }[] = [];
let failSorts = new Set<string>();

const PAGE_SIZE = 200;

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

  // جلسة بلا قاعدة: الحارس يسأل المخزن، فنجيب عنه
  built.ctx.sessions.resolve = async () => ({
    id: 'session-1',
    userId: 'user-1',
    username: 'dahmi',
    token: 'upstream-token',
  });
  built.ctx.sessions.touch = async () => undefined;

  // upstream مُسجَّل: يعدّ النداءات ويصنع صفحات مليئة حتى صفحة معيّنة
  built.ctx.uchiyomi.librarySearch = (async (
    _token: string,
    body: { page?: number; size?: number; sort?: string; query?: string } = {},
  ) => {
    calls.push(body);
    const sort = body.sort ?? '';
    if (failSorts.has(sort)) throw new Error('upstream down');
    const page = body.page ?? 0;
    const size = body.size ?? PAGE_SIZE;
    // ثلاث صفحات كاملة ثم صفحة ناقصة: مكتبة فيها ما يكفي لإظهار التكلفة
    const remaining = Math.max(0, 3 * PAGE_SIZE + 7 - page * size);
    const count = Math.min(size, remaining);
    return {
      content: Array.from({ length: count }, (_, index) => ({
        id: `series-${page * size + index}`,
        name: `عمل ${page * size + index}`,
        booksCount: 10,
        booksUnreadCount: 2,
        booksInProgressCount: 1,
      })),
      totalElements: 3 * PAGE_SIZE + 7,
      last: count < size,
    };
  }) as typeof built.ctx.uchiyomi.librarySearch;

  built.ctx.uchiyomi.listSources = (async () => [
    { id: 'src-1', name: 'مصدر', lang: 'ar' },
  ]) as typeof built.ctx.uchiyomi.listSources;

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

const cookie = `${SESSION_COOKIE}=session-1`;

function reset() {
  calls = [];
  failSorts = new Set();
  deletedRows = [];
}

describe('GET /v1/library/browse', () => {
  it('costs exactly one upstream call per page', async () => {
    reset();
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.json().content).toHaveLength(40);
    expect(res.json()).toMatchObject({ page: 0, size: 40, sort: 'updated', hasMore: true });
  });

  it('is far cheaper than the audit path it replaces for screens', async () => {
    // نفس المكتبة: مسار التدقيق يمشي كل الصفحات، وعقد الشاشة صفحة واحدة
    reset();
    await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    const screenCalls = calls.length;

    reset();
    await app.inject({ method: 'GET', url: '/v1/library', headers: { cookie } });
    const auditCalls = calls.length;

    expect(screenCalls).toBe(1);
    expect(auditCalls).toBeGreaterThan(screenCalls);
  });

  it('passes the sort upstream instead of sorting a full copy here', async () => {
    reset();
    await app.inject({ method: 'GET', url: '/v1/library/browse?sort=unread', headers: { cookie } });
    expect(calls[0]?.sort).toBe('unread,desc');
  });

  it('falls back to a known sort instead of forwarding a made-up one', async () => {
    reset();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library/browse?sort=chaos',
      headers: { cookie },
    });
    expect(res.json().sort).toBe('updated');
    expect(calls[0]?.sort).toBe('updated,desc');
  });

  it('forwards a search query and keeps paging', async () => {
    reset();
    await app.inject({
      method: 'GET',
      url: '/v1/library/browse?q=nano&page=2&size=10',
      headers: { cookie },
    });
    expect(calls[0]).toMatchObject({ query: 'nano', page: 2, size: 10 });
  });

  it('hides a work deleted for everyone', async () => {
    reset();
    deletedRows = [{ series_ref: 'series-0' }];
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    const ids = res.json().content.map((row: { id: string }) => row.id);
    expect(ids).not.toContain('series-0');
    expect(ids).toContain('series-1');
  });

  it('reports the last page honestly', async () => {
    reset();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library/browse?page=15&size=40',
      headers: { cookie },
    });
    expect(res.json().hasMore).toBe(false);
    expect(res.json().content.length).toBeLessThan(40);
  });

  it('caps an oversized page and says which size it used', async () => {
    // طلب 500 عمل في نداء واحد يُعيدنا إلى نفس مشكلة الصفحة الواحدة الضخمة
    reset();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library/browse?size=500',
      headers: { cookie },
    });
    expect(res.json().size).toBe(40);
    expect(calls[0]?.size).toBe(40);
  });

  it('answers 502 when upstream is down instead of an empty library', async () => {
    reset();
    failSorts = new Set(['updated,desc']);
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse', headers: { cookie } });
    expect(res.statusCode).toBe(502);
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/library/browse' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/explore', () => {
  it('returns four sections, one upstream call each', async () => {
    reset();
    const res = await app.inject({ method: 'GET', url: '/v1/explore', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const sections = res.json().content;
    expect(sections.map((s: { key: string }) => s.key)).toEqual([
      'unread',
      'updated',
      'added',
      'random',
    ]);
    expect(calls).toHaveLength(4);
    for (const section of sections) expect(section.available).toBe(true);
  });

  it('keeps the other sections when one fails', async () => {
    // قسم متعثّر لا يُفرّغ الشاشة
    reset();
    failSorts = new Set(['random,asc']);
    const res = await app.inject({ method: 'GET', url: '/v1/explore', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const sections = res.json().content;
    const random = sections.find((s: { key: string }) => s.key === 'random');
    expect(random).toMatchObject({ available: false, content: [] });
    expect(sections.filter((s: { available: boolean }) => s.available)).toHaveLength(3);
  });

  it('caps each section', async () => {
    reset();
    const res = await app.inject({ method: 'GET', url: '/v1/explore?size=5', headers: { cookie } });
    for (const section of res.json().content) expect(section.content.length).toBeLessThanOrEqual(5);
    for (const call of calls) expect(call.size).toBe(5);
  });

  it('hides a deleted work from every section', async () => {
    reset();
    deletedRows = [{ series_ref: 'series-0' }];
    const res = await app.inject({ method: 'GET', url: '/v1/explore', headers: { cookie } });
    for (const section of res.json().content) {
      expect(section.content.map((row: { id: string }) => row.id)).not.toContain('series-0');
    }
  });

  it('lists sources without leaking their diagnostics', async () => {
    reset();
    const res = await app.inject({ method: 'GET', url: '/v1/explore/sources', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().content[0]).toEqual({ id: 'src-1', name: 'مصدر', lang: 'ar' });
    // لا حكم ولا دليل ولا آخر فحص: تلك مسارات المصادر لا وجهة القارئ
    expect(JSON.stringify(res.json())).not.toMatch(/verdict|evidence|tested/i);
  });

  it('needs a session for both explore paths', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/explore' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/explore/sources' })).statusCode).toBe(401);
  });
});
