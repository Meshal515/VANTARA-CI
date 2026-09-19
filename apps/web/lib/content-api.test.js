import { describe, expect, it, vi } from 'vitest';
import { requestContent } from './content-api.js';

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { 'content-type': 'application/json' },
  });
}

describe('Content API bearer transport', () => {
  it('sends the current VANTARA identity token with JSON requests', async () => {
    const fetchMock = vi.fn(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const sync = {
      authorizationHeader: 'Bearer identity-token-1',
      signedIn: true,
      refreshSession: vi.fn(),
    };

    await requestContent({
      baseUrl: 'https://api.example',
      sync,
      path: '/v1/library',
      options: { method: 'POST', body: { hello: 'world' } },
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example/v1/library');
    expect(options.credentials).toBe('include');
    expect(options.headers.authorization).toBe('Bearer identity-token-1');
    expect(options.headers['content-type']).toBe('application/json');
    expect(options.body).toBe(JSON.stringify({ hello: 'world' }));
    vi.unstubAllGlobals();
  });

  it('refreshes once on 401 and retries the exact request with the new token', async () => {
    let token = 'identity-token-old';
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => response({ error: 'unauthorized' }, 401))
      .mockImplementationOnce(async () => response({ content: ['ok'] }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const sync = {
      get authorizationHeader() {
        return `Bearer ${token}`;
      },
      signedIn: true,
      refreshSession: vi.fn(async () => {
        token = 'identity-token-new';
      }),
    };

    const result = await requestContent({
      baseUrl: 'https://api.example',
      sync,
      path: '/v1/search?q=x',
      options: { method: 'GET' },
    });

    expect(result).toEqual({ content: ['ok'] });
    expect(sync.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer identity-token-old');
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer identity-token-new');
    vi.unstubAllGlobals();
  });

  it('never loops refresh when the retried request is still unauthorized', async () => {
    const fetchMock = vi.fn(async () => response({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const sync = {
      authorizationHeader: 'Bearer identity-token',
      signedIn: true,
      refreshSession: vi.fn(async () => {}),
    };

    await expect(
      requestContent({
        baseUrl: 'https://api.example',
        sync,
        path: '/v1/library',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unauthorized' });

    expect(sync.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  /**
   * ما فوق العقد: الحالات التي تجعل هذا النقل صالحًا للويب أيضًا، لا للـAPK
   * وحده. الويب ما زال يعمل بالكوكي، فالنقل الذي يفترض وجود توكن يكسره.
   */

  it('still works with no identity at all, on the cookie path', async () => {
    const fetchMock = vi.fn(async () => response({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await requestContent({ sync: { signedIn: false }, path: '/v1/library' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/v1/library');
    expect(options.headers.authorization).toBeUndefined();
    // بلا `baseUrl` نحن على نفس الأصل (الويب): `same-origin` هو الصحيح هناك،
    // و`include` يُرسل حيث لا حاجة. كان تأكيدي يفرض `include` دائمًا — والعقد
    // المدموج أدقّ: الاعتماد يُوسَّع عند عبور الأصل فقط.
    expect(options.credentials).toBe('same-origin');
    vi.unstubAllGlobals();
  });

  it('widens credentials only when the api lives on another origin', async () => {
    const fetchMock = vi.fn(async () => response({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await requestContent({ baseUrl: 'https://api.example', sync: {}, path: '/v1/library' });

    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
    vi.unstubAllGlobals();
  });

  it('does not retry a 401 when there is nothing to refresh', async () => {
    // بلا هذا كان النداء يُرسل مرتين لكل زائر غير مسجَّل
    const fetchMock = vi.fn(async () => response({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requestContent({ sync: { signedIn: false }, path: '/v1/library' }),
    ).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('reports the 401 when the refresh itself fails, without a pointless retry', async () => {
    // فشل التجديد ليس الخطأ الذي يهمّ المُنادي: الأصل أن الطلب رجع 401.
    //
    // وكان تأكيدي يتوقّع محاولة ثانية. العقد المدموج لا يعيد المحاولة، وهو
    // أصحّ: التجديد فشل ⇒ التوكن لم يتغيّر ⇒ إعادة نفس الطلب بنفس الترويسة
    // نداءٌ يُعرف فشله قبل إرساله.
    const fetchMock = vi.fn(async () => response({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const sync = {
      authorizationHeader: 'Bearer dead',
      signedIn: true,
      refreshSession: vi.fn(async () => {
        throw new Error('network down');
      }),
    };

    await expect(requestContent({ sync, path: '/v1/library' })).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(sync.refreshSession).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('returns null for a 204 instead of throwing on an empty body', async () => {
    // `PUT /progress` يرجع 204: محاولة قراءة JSON منه كانت ترمي
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requestContent({ sync: {}, path: '/v1/books/x/progress', options: { method: 'PUT' } }),
    ).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('carries the server error code so callers can branch on it', async () => {
    // `ensureLocal` يتوقف عند 409 ويعيد المحاولة على غيره
    const fetchMock = vi.fn(async () => response({ error: 'no_copies_left' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestContent({ sync: {}, path: '/v1/x' })).rejects.toMatchObject({
      status: 409,
      code: 'no_copies_left',
    });
    vi.unstubAllGlobals();
  });

  it('does not send a body or a content-type on a GET', async () => {
    const fetchMock = vi.fn(async () => response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await requestContent({ sync: {}, path: '/v1/library', options: { method: 'GET' } });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toBeUndefined();
    expect(options.headers['content-type']).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('B10 — الخيط إلى سطر السجلّ', () => {
  it('يحمل معرّف الربط من الترويسة على الخطأ', async () => {
    // بلا هذا يصل البلاغ ومعه الوقت وحده، والسجلّ فيه مئة سطر في تلك الدقيقة
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'internal_error' }), {
            status: 500,
            headers: { 'content-type': 'application/json', 'x-correlation-id': 'req-abc12345' },
          }),
      ),
    );

    await expect(
      requestContent({ baseUrl: 'https://api.example', path: '/v1/library' }),
    ).rejects.toMatchObject({ status: 500, correlationId: 'req-abc12345' });
  });

  it('يقع على المعرّف في الجسم حين تغيب الترويسة', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'internal_error', correlationId: 'body-abc12345' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      requestContent({ baseUrl: 'https://api.example', path: '/v1/library' }),
    ).rejects.toMatchObject({ correlationId: 'body-abc12345' });
  });

  it('لا يخترع معرّفًا حين لا يرسله الخادم', async () => {
    // معرّفٌ لا يقابله سطر خيطٌ لا يصل إلى شيء، وهو أسوأ من غيابه
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(
      requestContent({ baseUrl: 'https://api.example', path: '/v1/library' }),
    ).rejects.toMatchObject({ correlationId: null });
  });
});
