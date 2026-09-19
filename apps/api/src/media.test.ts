/**
 * B3 — هل تُعرض صفحة الفصل على الـAPK أصلًا؟
 *
 * `<img src>` لا يحمل ترويسة `Authorization`، والكوكي cross-site من أصل الـAPK
 * لا يُرسل (`Lax`). فمسار `/v1/img/page/*` المحمي بجلسة يعمل في المتصفح ويفشل
 * في التطبيق: **فصل كامل من صور مكسورة، بلا خطأ ظاهر**.
 *
 * ما تُثبته هذه الاختبارات:
 *
 * 1. الرابط الموقَّع يُفتح **بلا أي اعتماد** — وهذا جوهر الإصلاح.
 * 2. لا يُفتح به غير ما وُقِّع عليه: رقم صفحة أو معرّف كتاب مُعدَّل ⇒ رفض.
 * 3. الرفض يُفرّق بين «انتهى» (يكفيه تجديد) و«توقيع خاطئ» (لا يكفيه شيء).
 * 4. بلا توكن خدمة يُقال ذلك **عند التوقيع** لا عند كل صورة، فيسقط العميل
 *    لمسار الكوكي مرة واحدة بدل ثلاثين رابطًا كلها 503.
 * 5. لا يُعاد إلا ما يُثبت أنه صورة: صفحة تحدٍّ بترويسة HTML ⇒ 502 لا صورة.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signMediaPath } from '@vantara/domain';

vi.mock('@vantara/db', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  transaction: vi.fn(async () => undefined),
  initPool: vi.fn(),
  closePool: vi.fn(async () => undefined),
}));

const { buildApp } = await import('./app.ts');
const { loadConfig } = await import('./lib/config.ts');
const { SESSION_COOKIE } = await import('./lib/context.ts');

const SECRET = 'test-secret-that-is-at-least-32-chars-long';
const SERVICE_TOKEN = 'uy_service_token';
const BOOK = 'book-42';

/** ما وصل المنبع: المسار والترويسات — الدليل على *بأي توكن* جُلبت الصفحة. */
let upstreamCalls: { url: string; authorization: string | null }[] = [];
/** ما يرجعه المنبع للنداء القادم. */
let upstreamReply: () => Response = () =>
  new Response('page-bytes', {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '10' },
  });

const configFor = (serviceToken: string | undefined) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    UCHIYOMI_URL: 'http://uchiyomi.internal:3000',
    SESSION_SECRET: SECRET,
    // B2 جعله إلزاميًّا: الـContent API لا يتحقق من توكن الهوية بلا سرّه
    VANTARA_IDENTITY_SECRET: 'test-identity-secret-at-least-32-chars-x',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    ...(serviceToken !== undefined ? { UCHIYOMI_SERVICE_TOKEN: serviceToken } : {}),
  });

const withSession = async (
  app: FastifyInstance,
  ctx: { sessions: { resolve: unknown; touch: unknown } },
) => {
  // جلسة بلا قاعدة: الحارس يسأل المخزن، فنجيب عنه
  ctx.sessions.resolve = async () => ({
    id: 'session-1',
    userId: 'user-1',
    username: 'dahmi',
    token: 'user-upstream-token',
  });
  ctx.sessions.touch = async () => undefined;
  await app.ready();
};

/** التطبيق كما يُنشر: بتوكن خدمة. */
let app: FastifyInstance;
/** نفس التطبيق بلا توكن خدمة — حالة الإعداد الناقص. */
let unconfigured: FastifyInstance;

const cookie = `${SESSION_COOKIE}=session-1`;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers ?? {});
    upstreamCalls.push({ url, authorization: headers.get('authorization') });
    return upstreamReply();
  });

  const built = await buildApp(configFor(SERVICE_TOKEN));
  app = built.app;
  await withSession(app, built.ctx as unknown as Parameters<typeof withSession>[1]);

  const bare = await buildApp(configFor(undefined));
  unconfigured = bare.app;
  await withSession(unconfigured, bare.ctx as unknown as Parameters<typeof withSession>[1]);
});

afterEach(() => {
  upstreamCalls = [];
  upstreamReply = () =>
    new Response('page-bytes', {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '10' },
    });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await unconfigured?.close();
});

const mint = (pages: number[], headers: Record<string, string> = { cookie }) =>
  app.inject({
    method: 'POST',
    url: '/v1/media/pages',
    headers,
    payload: { bookId: BOOK, pages },
  });

interface MintResponse {
  bookId: string;
  expiresAt: number;
  content: { page: number; url: string }[];
}

describe('minting signed page urls', () => {
  it('needs a session — the signature is the whole permission', async () => {
    const res = await mint([1], {});
    expect(res.statusCode).toBe(401);
  });

  it('returns relative urls so no api host is baked into stored data', async () => {
    const res = await mint([1, 2, 3]);
    expect(res.statusCode).toBe(200);
    const body = res.json<MintResponse>();
    expect(body.content).toHaveLength(3);
    for (const entry of body.content) {
      expect(entry.url.startsWith('/v1/media/page/')).toBe(true);
      expect(entry.url).not.toContain('http');
    }
  });

  it('reports the nearest expiry so the client renews once, not per url', async () => {
    const before = Date.now();
    const body = (await mint([1, 2])).json<MintResponse>();
    expect(body.expiresAt).toBeGreaterThan(before);
    // خمس دقائق افتراضًا: تكفي لفتح فصل وقراءته بلا تجديد في المنتصف
    expect(body.expiresAt - before).toBeLessThanOrEqual(5 * 60_000 + 1_000);
  });

  it('does not sign an unbounded chapter', async () => {
    const res = await mint(Array.from({ length: 301 }, (_, i) => i));
    expect(res.statusCode).toBe(400);
  });

  it('says so up front when no service token is configured', async () => {
    // الصمت هنا كان يعطي العميل فصلًا من روابط كلها 503
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/v1/media/pages',
      headers: { cookie },
      payload: { bookId: BOOK, pages: [1] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toBe('media_unconfigured');
  });
});

describe('fetching a signed page', () => {
  const signedUrlFor = async (page: number) => {
    const body = (await mint([page])).json<MintResponse>();
    const found = body.content.find((entry) => entry.page === page);
    if (!found) throw new Error('mint did not return the page');
    return found.url;
  };

  it('streams with no cookie and no header at all — this is the fix', async () => {
    const url = await signedUrlFor(7);
    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body).toBe('page-bytes');
  });

  it('fetches upstream with the service token, never the reader session token', async () => {
    const url = await signedUrlFor(7);
    upstreamCalls = [];
    await app.inject({ method: 'GET', url });

    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.url).toBe(`http://uchiyomi.internal:3000/img/books/${BOOK}/page/7`);
    expect(upstreamCalls[0]?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });

  it('refuses a page nobody signed', async () => {
    const url = await signedUrlFor(7);
    // نفس التوقيع، رقم آخر: لو نجح لكان رابط صفحة واحدة مفتاح الفصل كله
    const tampered = url.replace(`/${BOOK}/7?`, `/${BOOK}/8?`);
    const res = await app.inject({ method: 'GET', url: tampered });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('bad_signature');
    expect(upstreamCalls.filter((call) => call.url.includes('/page/8'))).toHaveLength(0);
  });

  it('refuses a token minted for another book', async () => {
    const url = await signedUrlFor(7);
    const token = url.split('?t=')[1];
    const res = await app.inject({
      method: 'GET',
      url: `/v1/media/page/other-book/7?t=${String(token)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a request with no signature', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/media/page/${BOOK}/7`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('signature_required');
  });

  it('answers an expired signature with 401 so the client knows a renewal suffices', async () => {
    const path = `/v1/media/page/${BOOK}/7`;
    const { token } = await signMediaPath({
      path,
      userId: 'user-1',
      secret: SECRET,
      // موقَّع في الماضي: عمره الافتراضي انقضى
      now: Date.now() - 10 * 60_000,
    });
    const res = await app.inject({
      method: 'GET',
      url: `${path}?t=${encodeURIComponent(token)}`,
    });

    // ‏401 لا 403: التجديد يكفي، فلا يعرض القارئ خطأً دائمًا لصورة قابلة للعرض
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('expired');
  });

  it('refuses a signature made with another secret', async () => {
    const path = `/v1/media/page/${BOOK}/7`;
    const { token } = await signMediaPath({
      path,
      userId: 'user-1',
      secret: 'another-secret-that-is-at-least-32-chars',
    });
    const res = await app.inject({
      method: 'GET',
      url: `${path}?t=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps maxWidth outside the signature but clamped', async () => {
    const url = await signedUrlFor(7);
    upstreamCalls = [];
    // نفس الصورة بحجم آخر ليست محتوى آخر؛ وإدخال الحجم في التوقيع يعني
    // رابطًا لكل حجم. والحدّ يمنع استخدامه كعبء معالجة.
    const res = await app.inject({
      method: 'GET',
      url: `${url}&maxWidth=99999`,
    });

    expect(res.statusCode).toBe(200);
    expect(upstreamCalls[0]?.url).toContain('maxWidth=4096');
  });

  it('does not hand a challenge page to the reader as an image', async () => {
    const url = await signedUrlFor(7);
    upstreamReply = () =>
      new Response('<html>cloudflare</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: string }>().error).toBe('not_an_image');
  });

  it('passes a missing page through as a missing page', async () => {
    const url = await signedUrlFor(7);
    upstreamReply = () => new Response('nope', { status: 404 });

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
  });

  it('will not stream without a service token even with a valid signature', async () => {
    const path = `/v1/media/page/${BOOK}/7`;
    const { token } = await signMediaPath({
      path,
      userId: 'user-1',
      secret: SECRET,
    });
    const res = await unconfigured.inject({
      method: 'GET',
      url: `${path}?t=${encodeURIComponent(token)}`,
    });

    expect(res.statusCode).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('is cached privately so a shared proxy cannot serve it to the unsigned', async () => {
    const url = await signedUrlFor(7);
    const res = await app.inject({ method: 'GET', url });
    expect(String(res.headers['cache-control'])).toContain('private');
  });
});
