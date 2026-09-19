/**
 * B3 — هل يستطيع الـAPK أن يكلّم الـContent API أصلًا؟
 *
 * Capacitor يقدّم الصفحة من `https://localhost`، فكل نداء إلى الـAPI
 * cross-origin. والـAPI كان بلا CORS إطلاقًا لأن الويب يُقدَّم من نفس الأصل:
 * النتيجة أن **كل** ميزة محتوى على الـAPK تفشل عند الـpreflight — المكتبة
 * والبحث والفصول والصور — ويظهر للمستخدم كانقطاع شبكة لا كخطأ إعداد.
 *
 * هذه الاختبارات بلا قاعدة وبلا منبع: الترويسات تُضاف قبل أي حارس.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@vantara/db', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  transaction: vi.fn(async () => undefined),
  initPool: vi.fn(),
  closePool: vi.fn(async () => undefined),
}));

const { buildApp } = await import('./app.ts');
const { loadConfig } = await import('./lib/config.ts');

let app: FastifyInstance;

const APK_ORIGIN = 'https://localhost';
const PAGES_ORIGIN = 'https://vantara.pages.dev';

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    UCHIYOMI_URL: 'http://127.0.0.1:1',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    // B2 جعله إلزاميًّا: الـContent API لا يتحقق من توكن الهوية بلا سرّه
    VANTARA_IDENTITY_SECRET: 'test-identity-secret-at-least-32-chars-x',
    COOKIE_SECURE: 'false',
    ALLOWED_ORIGINS: `${PAGES_ORIGIN}, https://vantara.example.com`,
    LOG_LEVEL: 'error',
  });
  ({ app } = await buildApp(config));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe('the APK origin', () => {
  it('is allowed to preflight a content call', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/library',
      headers: {
        origin: APK_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(APK_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-headers'])).toContain('authorization');
  });

  it('gets the allow header on the real call too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library',
      headers: { origin: APK_ORIGIN },
    });
    // 401 لأن لا جلسة — والمهم أن الجواب يحمل ترويسة السماح، وإلا لم يقرأه العميل
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(APK_ORIGIN);
  });

  it('answers the preflight without touching a session or the database', async () => {
    // preflight يُجاب قبل الحارس: 401 على OPTIONS يبدو للمتصفح رفض CORS
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/books/x/pages',
      headers: { origin: APK_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('is offered for every method the client uses', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/books/x/progress',
      headers: { origin: APK_ORIGIN, 'access-control-request-method': 'PUT' },
    });
    const methods = String(res.headers['access-control-allow-methods']);
    for (const method of ['GET', 'POST', 'PUT']) expect(methods).toContain(method);
  });
});

describe('the configured Pages origin', () => {
  it('is allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library',
      headers: { origin: PAGES_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
  });
});

describe('an origin nobody allowed', () => {
  it('gets no allow header, so the browser blocks it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is not told whether the path exists', async () => {
    // الرفض بحالة مختلفة يكشف لصفحة معادية أن المسار موجود
    const known = await app.inject({
      method: 'OPTIONS',
      url: '/v1/library',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    const unknown = await app.inject({
      method: 'OPTIONS',
      url: '/v1/does-not-exist',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never receives a wildcard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library',
      headers: { origin: 'https://evil.example' },
    });
    // `*` مع اعتماد يرفضه المتصفح، ويعني أن أي صفحة تقرأ مكتبة المستخدم
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('caching', () => {
  it('varies on origin so a shared cache cannot cross the wires', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/library',
      headers: { origin: APK_ORIGIN },
    });
    expect(String(res.headers['vary'])).toContain('origin');
  });

  it('adds nothing to a same-origin request', async () => {
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});
