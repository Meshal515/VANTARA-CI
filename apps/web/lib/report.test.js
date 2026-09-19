import { describe, expect, it, vi } from 'vitest';
import { REPORT_KINDS, clientSnapshot, submitReport } from './report.js';

describe('the snapshot a report carries', () => {
  it('keeps only the fields it names', () => {
    // قائمة سماح لا منع: الخادم ينقّي بقائمة محظورات، وهي شبكة أمان ثانية.
    // أما هنا فلا يُجمع إلا المسمّى، فلا يركب شيء بالخطأ من كائن أوسع.
    const snap = clientSnapshot({
      appVersion: '0.1.0',
      screen: 'reader',
      health: { state: 'syncing', pending: 3, quarantined: 1 },
      online: true,
      token: 'eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaa.bbbbbbbbbbbb',
      deviceCredential: 'super-secret-credential',
      cookie: 'session=abc',
    });

    expect(snap.appVersion).toBe('0.1.0');
    expect(snap.screen).toBe('reader');
    expect(snap.syncState).toBe('syncing');
    expect(Object.keys(snap)).not.toContain('token');
    expect(Object.keys(snap)).not.toContain('deviceCredential');
    expect(Object.keys(snap)).not.toContain('cookie');
    expect(JSON.stringify(snap)).not.toContain('super-secret-credential');
  });

  it('strips the query off any url it carries', () => {
    // رابط الصفحة الموقَّع `?t=<hmac>` يفتح الصفحة بلا جلسة. المسار يفيد
    // التشخيص، والتوقيع لا يفيد شيئًا — فلا يُرسل من أصله.
    const snap = clientSnapshot({
      lastImage: '/v1/media/page/x/7?t=9f8e7d6c5b4a39281706f5e4d3c2b1a0deadbeef',
      endpoint: 'https://api.example/v1?key=abcdefghijklmnop',
    });

    expect(snap.lastImage).toBe('/v1/media/page/x/7');
    expect(snap.lastImage).not.toContain('t=');
    // المسار يبقى كاملًا — هو ما يفيد التشخيص — والمعاملات وحدها تُقطع
    expect(snap.endpoint).toBe('https://api.example/v1');
    expect(snap.endpoint).not.toContain('key=');
  });

  it('reduces the last error to a status, not an object', () => {
    // كائن الخطأ يحمل ما لا نعرفه: رسالة، أثرًا، ربما رابطًا موقَّعًا
    const snap = clientSnapshot({
      lastError: { status: 503, at: 123, message: 'Bearer aaaaaaaaaaaaaaaa failed' },
    });
    expect(snap.lastErrorStatus).toBe(503);
    expect(JSON.stringify(snap)).not.toContain('Bearer');
  });

  it('never invents values it was not given', () => {
    const snap = clientSnapshot({});
    for (const value of Object.values(snap)) {
      expect(value === null || typeof value !== 'object').toBe(true);
    }
  });
});

describe('sending a report', () => {
  it('posts the allowlisted snapshot under client', async () => {
    const api = vi.fn(async () => ({ id: 'r1', state: 'OPEN' }));
    const result = await submitReport({
      api,
      kind: 'MISSING_PAGE',
      seriesRef: 'src:test:x',
      pageIndex: 7,
      description: 'الصفحة بيضاء',
      context: { appVersion: '0.1.0', screen: 'reader', token: 'leak-me' },
    });

    expect(result).toEqual({ id: 'r1', state: 'OPEN' });
    const [path, options] = api.mock.calls[0];
    expect(path).toBe('/v1/reports');
    expect(options.method).toBe('POST');
    expect(options.body.kind).toBe('MISSING_PAGE');
    expect(options.body.pageIndex).toBe(7);
    expect(JSON.stringify(options.body)).not.toContain('leak-me');
  });

  it('refuses a kind the server does not know', async () => {
    // نوع مجهول يرجع 400 من الخادم بعد رحلة كاملة، ويضيع بلاغ المستخدم
    const api = vi.fn();
    await expect(submitReport({ api, kind: 'NOT_A_KIND' })).rejects.toThrow('unknown_kind');
    expect(api).not.toHaveBeenCalled();
  });

  it('omits empty optional fields instead of sending nulls', async () => {
    // `zod` على الخادم يقبل الغياب ويرفض `null` في حقل نصّي
    const api = vi.fn(async () => ({ id: 'r2' }));
    await submitReport({ api, kind: 'OTHER', context: {} });

    const body = api.mock.calls[0][1].body;
    expect('seriesRef' in body).toBe(false);
    expect('pageIndex' in body).toBe(false);
    expect(body.kind).toBe('OTHER');
  });

  it('exposes the same kinds the server accepts', () => {
    expect(REPORT_KINDS).toContain('CHAPTER_WONT_OPEN');
    expect(REPORT_KINDS).toContain('MISSING_PAGE');
    expect(REPORT_KINDS).toContain('OTHER');
  });
});
