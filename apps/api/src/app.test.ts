/**
 * اختبارات تكامل حقيقية: PostgreSQL حقيقي وUchiyomi حقيقي.
 *
 * لا mocks لطبقة الشبكة. إذا لم يتوفر أحدهما تُتجاوز الاختبارات بوضوح بدل أن
 * تنجح كذبًا على أضعاف مزيفة.
 *
 *   UCHIYOMI_URL=http://127.0.0.1:8080 \
 *   DATABASE_URL=postgres://vantara:vantara_dev@127.0.0.1:5433/vantara \
 *   TEST_USERNAME=mishal TEST_PASSWORD=... pnpm --filter @vantara/api test
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initPool, query } from '@vantara/db';
import { buildApp } from './app.ts';
import { loadConfig } from './lib/config.ts';
import { SESSION_COOKIE } from './lib/context.ts';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://vantara:vantara_dev@127.0.0.1:5433/vantara';
const UCHIYOMI_URL = process.env['UCHIYOMI_URL'] ?? 'http://127.0.0.1:8080';
const USERNAME = process.env['TEST_USERNAME'] ?? 'mishal';
// لا كلمة مرور افتراضية في الكود: أي قيمة هنا تصبح سرًّا منشورًا في المستودع
const PASSWORD = process.env['TEST_PASSWORD'];
const REQUIRE_LIVE_INTEGRATION = process.env['VANTARA_REQUIRE_LIVE_INTEGRATION'] === 'true';

let app: FastifyInstance;
let cookie = '';
let ready = false;
/** سبب التخطي، يُطبع مرة واحدة بدل 20 فشلًا متتاليًا بلا تفسير. */
let skipReason = '';

beforeAll(async () => {
  if (!PASSWORD) {
    skipReason = 'TEST_PASSWORD is not set';
    if (REQUIRE_LIVE_INTEGRATION) throw new Error(`live integration required: ${skipReason}`);
    return;
  }
  initPool({ connectionString: DATABASE_URL });
  try {
    await query('SELECT 1');
    const probe = await fetch(`${UCHIYOMI_URL}/livez`, {
      signal: AbortSignal.timeout(4_000),
    });
    ready = probe.ok;
  } catch (error) {
    ready = false;
    skipReason = error instanceof Error ? error.message : String(error);
  }
  if (!ready) {
    if (REQUIRE_LIVE_INTEGRATION) {
      throw new Error(`live integration required: dependencies unavailable (${skipReason || 'unknown error'})`);
    }
    return;
  }

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    UCHIYOMI_URL,
    SESSION_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    VANTARA_IDENTITY_SECRET: 'test-identity-secret-that-is-at-least-32-chars',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
  });
  ({ app } = await buildApp(config));
  await app.ready();

  // Uchiyomi يحدّ معدّل /auth/login. جلسة واحدة تكفي السويت كلها، ومحاولة
  // واحدة لكل تشغيل أفضل من محاولة لكل اختبار.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: USERNAME, password: PASSWORD },
    });
    if (res.statusCode === 200) {
      const jar = res.cookies.find((c) => c.name === SESSION_COOKIE);
      cookie = `${SESSION_COOKIE}=${jar?.value ?? ''}`;
      loginResponse = res;
      break;
    }
    if (res.statusCode !== 429) {
      skipReason = `login returned ${String(res.statusCode)}`;
      break;
    }
    skipReason = 'upstream rate-limited /auth/login';
    await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
  }

  if (cookie === '' && REQUIRE_LIVE_INTEGRATION) {
    throw new Error(`live integration required: no authenticated session (${skipReason || 'login failed'})`);
  }
}, 60_000);

/** استجابة تسجيل الدخول الناجحة، لتأكيدات الكوكي بلا تسجيل دخول ثانٍ. */
let loginResponse: Awaited<ReturnType<FastifyInstance['inject']>> | undefined;

afterAll(async () => {
  await app?.close();
  await closePool();
});

const skipUnlessReady = () => {
  if (!ready) {
    console.warn('skipping: needs live Postgres + Uchiyomi');
    return true;
  }
  return false;
};

/** للاختبارات التي تحتاج جلسة. تتخطى بسبب واضح بدل أن تفشل بـ401 مبهم. */
const skipUnlessSession = () => {
  if (skipUnlessReady()) return true;
  if (cookie === '') {
    console.warn(`skipping: no session (${skipReason})`);
    return true;
  }
  return false;
};

describe('health', () => {
  it('livez answers without touching the database', async () => {
    if (skipUnlessReady()) return;
    const res = await app.inject({ method: 'GET', url: '/livez' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('healthz reports both dependencies', async () => {
    if (skipUnlessReady()) return;
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: true, uchiyomi: true });
  });
});

describe('auth', () => {
  it('rejects a wrong password without revealing which part was wrong', async () => {
    if (skipUnlessReady()) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: USERNAME, password: 'definitely-not-the-password' },
    });
    // 429 مقبول: Uchiyomi يحدّ معدّل تسجيل الدخول، والمطلوب أن لا يُخفى السبب
    expect([401, 429]).toContain(res.statusCode);
    if (res.statusCode === 401) {
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
    }
  });

  it('rejects an unknown user with the same error as a wrong password', async () => {
    if (skipUnlessReady()) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'nobody-here', password: 'whatever' },
    });
    expect([401, 429]).toContain(res.statusCode);
    if (res.statusCode === 401) {
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
    }
  });

  it('logs in and sets an httpOnly cookie that is not the upstream token', () => {
    if (skipUnlessSession()) return;
    const res = loginResponse;
    expect(res).toBeDefined();
    if (!res) return;
    expect(res.statusCode).toBe(200);

    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(raw).toContain('HttpOnly');
    // التوكن العلوي لا يخرج إلى المتصفح بحال
    expect(raw).not.toContain('uy_');
    expect(JSON.stringify(res.json())).not.toContain('uy_');

    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeDefined();
  });

  it('refuses a protected route without a session', async () => {
    if (skipUnlessReady()) return;
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('resolves the session against upstream', async () => {
    if (skipUnlessSession()) return;
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: USERNAME });
  });

  it('treats a forged session id as unauthorized', async () => {
    if (skipUnlessSession()) return;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=forged-session-value` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('data ownership freeze', () => {
  /**
   * الاجتماعي كان له مسار ثانٍ كامل على هذا الـAPI فوق جداول PostgreSQL،
   * بينما التطبيق يقرأ ويكتب في D1. مالكان لنفس الحقيقة يعني تعليقًا يُكتب هنا
   * ولا يظهر لأحد، وبروفايلًا يُعدَّل هنا ولا يراه أي جهاز. هذه الاختبارات
   * تحرس التقاعد: عودة أي مسار منها تعني عودة المالك الثاني.
   */
  const retired: [string, string][] = [
    ['PATCH', '/v1/profiles/me'],
    ['GET', '/v1/profiles'],
    ['PUT', '/v1/profiles/me/adult'],
    ['POST', '/v1/presence/beat'],
    ['GET', '/v1/presence'],
    ['POST', '/v1/presence/leave'],
    ['PUT', '/v1/presence/incognito'],
    ['POST', '/v1/comments'],
    ['GET', '/v1/comments/test:spoiler'],
    ['POST', '/v1/recommendations'],
    ['GET', '/v1/recommendations/inbox'],
    ['GET', '/v1/activity'],
    ['GET', '/v1/read-together/test:nano'],
    ['GET', '/v1/stats/me'],
    ['PUT', '/v1/ratings/test:nano'],
  ];

  for (const [method, url] of retired) {
    it(`no longer serves ${method} ${url}`, async () => {
      if (skipUnlessSession()) return;
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie },
        ...(method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode).toBe(404);
    });
  }

  it('keeps the owner write path for library membership registered', async () => {
    if (skipUnlessSession()) return;
    // كان معرَّفًا وغير مسجَّل: الإضافة من البحث كانت ترجع 404 دائمًا. الجسم
    // الناقص يجب أن يُرفض بـ400، لا أن يغيب المسار نفسه.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/library/source',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the operational routes this store still owns', async () => {
    if (skipUnlessSession()) return;
    const reports = await app.inject({ method: 'GET', url: '/v1/reports', headers: { cookie } });
    expect(reports.statusCode).toBe(200);
    const split = await app.inject({
      method: 'POST',
      url: '/v1/merges/99999999/split',
      headers: { cookie },
      payload: {},
    });
    // 404 لأن اللقطة غير موجودة، أو 403 لغير المشرف — المهم أن المسار موجود
    expect([403, 404]).toContain(split.statusCode);
  });
});

describe('reports', () => {
  it('stores a report and scrubs secrets out of diagnostics', async () => {
    if (skipUnlessSession()) return;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { cookie },
      payload: {
        kind: 'MISSING_PAGE',
        seriesRef: 'test:nano',
        chapterRef: '184',
        pageIndex: 7,
        description: 'الصفحة السابعة فاضية',
        client: {
          appVersion: '0.1.0',
          cookie: 'session=abc123',
          authorization: 'Bearer uy_supersecretvalue123456',
          note: 'token uy_anothersecretvalue9876 leaked in text',
        },
      },
    });
    expect(res.statusCode).toBe(201);

    const stored = await query<{ diagnostics: unknown }>(
      `SELECT diagnostics FROM vantara_reports WHERE id = $1`,
      [res.json().id],
    );
    const dump = JSON.stringify(stored[0]?.diagnostics);
    // لا سرّ يبقى، لا في قيمة مفتاح محظور ولا داخل نص حر
    expect(dump).not.toContain('uy_supersecretvalue123456');
    expect(dump).not.toContain('uy_anothersecretvalue9876');
    expect(dump).not.toContain('session=abc123');
    expect(dump).toContain('redacted');
    expect(dump).toContain('0.1.0');
  });

  it('rejects an unknown report kind', async () => {
    if (skipUnlessSession()) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { cookie },
      payload: { kind: 'NOT_A_KIND' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('sources', () => {
  it('syncs the registry from upstream and registers untested sources', async () => {
    if (skipUnlessSession()) return;

    const res = await app.inject({ method: 'POST', url: '/v1/sources/sync', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);

    const list = await app.inject({ method: 'GET', url: '/v1/sources', headers: { cookie } });
    const rows = list.json().content as { verdict: string; hasEvidence: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    // لا مصدر يبدأ مدعومًا
    expect(rows.every((r) => r.verdict !== 'SUPPORTED' || r.hasEvidence)).toBe(true);
  });

  it('derives SUPPORTED only from complete evidence', async () => {
    if (skipUnlessSession()) return;

    const list = await app.inject({ method: 'GET', url: '/v1/sources', headers: { cookie } });
    const first = (list.json().content as { id: string }[])[0];
    expect(first).toBeDefined();

    const pass = {
      popular: { ok: true, count: 20 },
      search: { ok: true, count: 1, relevant: true },
      chapters: { ok: true, count: 332 },
      pagesOldest: { ok: true, count: 40 },
      pagesNewest: { ok: true, count: 22 },
      imagesDecoded: { ok: true, types: ['JPEG'] },
    };

    const supported = await app.inject({
      method: 'PUT',
      url: `/v1/sources/${encodeURIComponent(first?.id ?? '')}/evidence`,
      headers: { cookie },
      payload: pass,
    });
    expect(supported.json()).toMatchObject({ verdict: 'SUPPORTED' });

    // نفس المصدر، بحث يرجّع نتائج غير ذات صلة ⇒ SEARCH_BROKEN لا SUPPORTED
    const broken = await app.inject({
      method: 'PUT',
      url: `/v1/sources/${encodeURIComponent(first?.id ?? '')}/evidence`,
      headers: { cookie },
      payload: { ...pass, search: { ok: true, count: 11, relevant: false } },
    });
    expect(broken.json()).toMatchObject({ verdict: 'SEARCH_BROKEN' });

    // Cloudflare يُشخّص قبل أي شيء آخر
    const cf = await app.inject({
      method: 'PUT',
      url: `/v1/sources/${encodeURIComponent(first?.id ?? '')}/evidence`,
      headers: { cookie },
      payload: {
        ...pass,
        chapters: { ok: false, error: 'Cloudflare bypass currently disabled' },
      },
    });
    expect(cf.json()).toMatchObject({ verdict: 'NEEDS_FLARESOLVERR' });
  });
});

describe('deleted works', () => {
  it('requires the exact title as a second confirmation', async () => {
    if (skipUnlessSession()) return;
    await query(`DELETE FROM vantara_deleted_works WHERE series_ref = 'test:doomed'`);

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/deleted-works',
      headers: { cookie },
      payload: { seriesRef: 'test:doomed', seriesTitle: 'Doomed', confirmTitle: 'doomed' },
    });
    expect(wrong.statusCode).toBe(400);

    const right = await app.inject({
      method: 'POST',
      url: '/v1/deleted-works',
      headers: { cookie },
      payload: { seriesRef: 'test:doomed', seriesTitle: 'Doomed', confirmTitle: 'Doomed' },
    });
    expect(right.statusCode).toBe(201);
    // اللقطة تعدّ ما يملكه هذا المخزن فقط. عدّ التعليقات والتوصيات من جداول
    // PostgreSQL المتقاعدة كان سيكتب صفرًا بينما عند المالك عشرات.
    expect(right.json().snapshot).toMatchObject({ socialOwner: 'D1' });
    expect(right.json().snapshot).not.toHaveProperty('comments');
  });

  it('restores and reports what it carried', async () => {
    if (skipUnlessSession()) return;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/deleted-works/test%3Adoomed/restore',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restored: true });

    // الاستعادة الثانية لا شيء تستعيده
    const again = await app.inject({
      method: 'POST',
      url: '/v1/deleted-works/test%3Adoomed/restore',
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('logout', () => {
  it('invalidates the session server-side', async () => {
    if (skipUnlessSession()) return;

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});
