/**
 * سطح المسارات — بلا PostgreSQL وبلا Uchiyomi.
 *
 * اختبارات التكامل في `app.test.ts` تحتاج المخزنين الحقيقيين، فتتخطّى في CI.
 * لكن تقاعد مسار بعد تجميد الملكية (B4) حقيقة معمارية يجب أن يُثبت في كل تشغيل:
 * Fastify يطابق المسار قبل أي حارس، فالمسار الملغى يرجع 404 والمسار القائم يرجع
 * 401 بلا لمس قاعدة. هذا يكفي لإثبات من يملك ماذا على مستوى الشبكة.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './lib/config.ts';

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    // لا اتصال يُفتح في البناء؛ هذه قيم صياغة فقط
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    UCHIYOMI_URL: 'http://127.0.0.1:1',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    // B2 جعله إلزاميًّا: الـContent API لا يتحقق من توكن الهوية بلا سرّه
    VANTARA_IDENTITY_SECRET: 'test-identity-secret-at-least-32-chars-x',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
  });
  ({ app } = await buildApp(config));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

/** كل مسار اجتماعي كان له مالك ثانٍ على هذا الـAPI. */
const RETIRED: [string, string][] = [
  ['PATCH', '/v1/profiles/me'],
  ['GET', '/v1/profiles'],
  ['GET', '/v1/profiles/dahmi'],
  ['PUT', '/v1/profiles/me/adult'],
  ['POST', '/v1/presence/beat'],
  ['GET', '/v1/presence'],
  ['POST', '/v1/presence/leave'],
  ['PUT', '/v1/presence/incognito'],
  ['POST', '/v1/comments'],
  ['GET', '/v1/comments/test:series'],
  ['DELETE', '/v1/comments/1'],
  ['PUT', '/v1/comments/1/reactions/%F0%9F%94%A5'],
  ['DELETE', '/v1/comments/1/reactions/%F0%9F%94%A5'],
  ['POST', '/v1/recommendations'],
  ['GET', '/v1/recommendations/inbox'],
  ['PUT', '/v1/recommendations/1/state'],
  ['PUT', '/v1/ratings/test:series'],
  ['GET', '/v1/activity'],
  ['GET', '/v1/read-together/test:series'],
  ['GET', '/v1/stats/me'],
];

/** ما يملكه هذا المخزن فعلًا، أو ما يمرّره إلى مالكه. */
const KEPT: [string, string][] = [
  ['GET', '/v1/library'],
  ['GET', '/v1/series/x'],
  ['GET', '/v1/series/x/chapters'],
  ['GET', '/v1/series/x/versions'],
  ['GET', '/v1/books/x/pages'],
  ['GET', '/v1/books/x/progress'],
  ['PUT', '/v1/books/x/progress'],
  ['POST', '/v1/library/source'],
  ['GET', '/v1/search'],
  ['GET', '/v1/sources'],
  ['GET', '/v1/reports'],
  ['GET', '/v1/deleted-works'],
  ['POST', '/v1/merges/1/split'],
  ['POST', '/v1/media/pages'],
];

describe('route surface after the data ownership freeze', () => {
  for (const [method, url] of RETIRED) {
    it(`${method} ${url} is gone`, async () => {
      const res = await app.inject({ method: method as 'GET', url });
      expect(res.statusCode).toBe(404);
    });
  }

  for (const [method, url] of KEPT) {
    it(`${method} ${url} still exists and needs a session`, async () => {
      const res = await app.inject({ method: method as 'GET', url });
      // 401 يعني أن المسار موجود وحارسه يعمل. 404 هنا يعني أنه اختفى.
      expect(res.statusCode).toBe(401);
    });
  }

  it('serves liveness without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
  });

  it('keeps the signed page path reachable with no credential', async () => {
    // هذا المسار **يجب** أن يعمل بلا جلسة: `<img src>` لا يحمل ترويسة، والكوكي
    // لا يعبر الأصول. غيابه أو حراسته بجلسة = فصل مكسور على الـAPK.
    const res = await app.inject({ method: 'GET', url: '/v1/media/page/x/1' });
    // 401 signature_required لا 401 unauthorized: الرفض عن التوقيع لا عن الجلسة
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('signature_required');
  });

  it('keeps the account list public for the picker', async () => {
    // اختيار الحساب هو الدخول: قائمة الحسابات لا تحتاج جلسة
    const res = await app.inject({ method: 'GET', url: '/v1/auth/accounts' });
    expect(res.statusCode).not.toBe(401);
  });
});
