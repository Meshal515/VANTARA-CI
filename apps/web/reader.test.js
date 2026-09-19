/**
 * مسار حفظ التقدم — نقلًا لا عرضًا.
 *
 * هذا المسار يتجاوز عميل الـAPI المشترك (`api()` في `app.js`) لأنه يحتاج
 * `keepalive` و`sendBeacon`. وتجاوزه يعني أنه يفقد ما يضبطه العميل المشترك:
 * الاعتماد عبر الأصول. على الـAPK يعني ذلك 401 صامتًا في كل حفظ.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPageLoader, createProgressSaver } from './reader.js';

const ok = () => ({ ok: true, status: 204 });

describe('createProgressSaver', () => {
  it('sends credentials across origins', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
    });
    saver.update(12);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('stays same-origin in the browser build', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({ bookId: 'b1', fetchImpl, delayMs: 0 });
    saver.update(3);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('carries the identity header, since it bypasses the shared client', async () => {
    // على الـAPK لا كوكي عبر الأصول: بلا الترويسة يرجع 401 والتقدم لا يُحفظ
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
      authorization: () => 'Bearer identity-1',
    });
    saver.update(12);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer identity-1');
  });

  it('reads the identity at send time, not at construction', async () => {
    // التوكن عمره خمس عشرة دقيقة، والقارئ يبقى مفتوحًا أطول من ذلك
    let header = 'Bearer old';
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
      authorization: () => header,
    });
    header = 'Bearer fresh';
    saver.update(3);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer fresh');
  });

  it('confirms only what the owner accepted', async () => {
    const saved = [];
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
      onSaved: (page) => saved.push(page),
    });
    saver.update(9);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(saved).toEqual([]);
  });

  it('confirms a page the owner did accept', async () => {
    const saved = [];
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
      onSaved: (page) => saved.push(page),
    });
    saver.update(9);
    saver.flush();
    await vi.waitFor(() => expect(saved).toEqual([9]));
  });

  it('does not repeat the same page', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const saver = createProgressSaver({
      bookId: 'b1',
      baseUrl: 'https://api.example.com',
      fetchImpl,
      delayMs: 0,
    });
    saver.update(4);
    saver.flush();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    saver.update(4);
    saver.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * روابط الصفحات — الجزء الذي يقرّر هل يرى المستخدم فصلًا أم صورًا مكسورة.
 *
 * على الـAPK لا كوكي عبر الأصول، و`<img src>` لا يحمل ترويسة: فبلا رابط موقَّع
 * ترجع كل صفحة 401. وبتوقيع لا يُجدَّد، ترجع الصفحات الأخيرة من فصل طويل 401
 * أيضًا — لأن الصور `lazy` تُطلب بعد دقائق من بناء الفصل.
 */
describe('createPageLoader', () => {
  const BASE = 'https://api.example.com';

  const minted = (pages, { ttlMs = 5 * 60_000 } = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      bookId: 'b1',
      expiresAt: Date.now() + ttlMs,
      content: pages.map((page) => ({ page, url: `/v1/media/page/b1/${page}?t=sig-${page}` })),
    }),
  });

  it('signs the whole chapter in one call, not one per page', async () => {
    const fetchImpl = vi.fn(async () => minted([1, 2, 3]));
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1, 2, 3],
      baseUrl: BASE,
      fetchImpl,
    });

    await loader.prepare();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/v1/media/pages`);
    // الكوكي هو ما يُصرِّح بالتوقيع، وهو نداء JSON لا `<img>` — فيُرسل صراحةً
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('signs with the identity header, or the fix fails at its own door', async () => {
    // التوقيع نفسه نداء JSON بجلسة: بلا ترويسة يرجع 401 على الـAPK، فلا
    // روابط موقَّعة أصلًا — وإصلاح الصور يسقط عند أول خطوة
    const fetchImpl = vi.fn(async () => minted([1]));
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      baseUrl: BASE,
      fetchImpl,
      authorization: () => 'Bearer identity-1',
    });

    await loader.prepare();
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer identity-1');
  });

  it('omits the header when there is no identity, keeping the cookie path intact', async () => {
    const fetchImpl = vi.fn(async () => minted([1]));
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      baseUrl: BASE,
      fetchImpl,
      authorization: () => null,
    });

    await loader.prepare();
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('uses the signed url once signed', async () => {
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1, 2],
      baseUrl: BASE,
      fetchImpl: async () => minted([1, 2]),
    });

    await loader.prepare();
    expect(loader.urlFor(2)).toBe(`${BASE}/v1/media/page/b1/2?t=sig-2`);
    expect(loader.signing).toBe(true);
  });

  it('falls back to the cookie path when signing is unavailable', async () => {
    // خادم بلا توكن خدمة يرجع 503. الويب (أصل مشترك) يعمل بالكوكي، فالسقوط
    // إلى المسار القديم أفضل من فصل فارغ
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      maxWidth: 1100,
      baseUrl: BASE,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });

    expect(await loader.prepare()).toBe(false);
    expect(loader.urlFor(1)).toBe(`${BASE}/v1/img/page/b1/1?maxWidth=1100`);
    expect(loader.signing).toBe(false);
  });

  it('falls back when the network fails outright', async () => {
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      baseUrl: BASE,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });

    expect(await loader.prepare()).toBe(false);
    expect(loader.urlFor(1)).toBe(`${BASE}/v1/img/page/b1/1`);
  });

  it('treats a nearly expired signature as expired', async () => {
    // رابط يبقى عشر ثوانٍ لا يكفي لصورة تبدأ الآن على شبكة جوال
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      baseUrl: BASE,
      fetchImpl: async () => minted([1], { ttlMs: 10_000 }),
    });

    await loader.prepare();
    expect(loader.signing).toBe(false);
    expect(loader.urlFor(1)).toBe(`${BASE}/v1/img/page/b1/1`);
  });

  it('renews an expired signature so a long chapter keeps loading', async () => {
    let ttl = 10_000;
    const fetchImpl = vi.fn(async () => minted([1, 30], { ttlMs: ttl }));
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1, 30],
      baseUrl: BASE,
      fetchImpl,
    });

    await loader.prepare();
    expect(loader.signing).toBe(false);

    ttl = 5 * 60_000;
    expect(await loader.renew()).toBe(true);
    expect(loader.urlFor(30)).toBe(`${BASE}/v1/media/page/b1/30?t=sig-30`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not re-sign while a signature is still fresh', async () => {
    const fetchImpl = vi.fn(async () => minted([1]));
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      baseUrl: BASE,
      fetchImpl,
    });

    await loader.prepare();
    await loader.renew();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent signing into one request', async () => {
    // كل صفحة تفشل تطلب تجديدًا: ثلاثون صفحة = ثلاثون نداءً بلا هذا
    let resolveMint;
    const fetchImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveMint = () => resolve(minted([1, 2]));
        }),
    );
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1, 2],
      baseUrl: BASE,
      fetchImpl,
    });

    const first = loader.prepare();
    const second = loader.prepare();
    resolveMint();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('splits a chapter longer than the server cap instead of giving up on it', async () => {
    // رفض النداء يعني السقوط لمسار الكوكي — أي فصلًا مكسورًا على الـAPK
    const pages = Array.from({ length: 640 }, (_, index) => index + 1);
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.pages.length).toBeLessThanOrEqual(300);
      return minted(body.pages);
    });
    const loader = createPageLoader({ bookId: 'b1', pageNumbers: pages, fetchImpl });

    expect(await loader.prepare()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(loader.urlFor(640)).toBe('/v1/media/page/b1/640?t=sig-640');
  });

  it('keeps the relative api base out of stored urls', async () => {
    // بلا baseUrl (الويب): المسار نسبي كما يجب أن يكون
    const loader = createPageLoader({
      bookId: 'b1',
      pageNumbers: [1],
      fetchImpl: async () => minted([1]),
    });

    await loader.prepare();
    expect(loader.urlFor(1)).toBe('/v1/media/page/b1/1?t=sig-1');
  });
});
