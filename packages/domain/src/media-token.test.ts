import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEDIA_TOKEN_TTL_MS,
  MAX_MEDIA_TOKEN_TTL_MS,
  mediaUrl,
  signMediaPath,
  verifyMediaToken,
} from './media-token.ts';

const SECRET = 'a-secret-that-is-at-least-32-characters-long';
const PATH = '/v1/media/page/book-1/4';
const NOW = 1_700_000_000_000;

describe('signMediaPath', () => {
  it('signs a path for one user with an expiry', async () => {
    const { token, expiresAt } = await signMediaPath({
      path: PATH,
      userId: 'u1',
      secret: SECRET,
      now: NOW,
    });
    expect(token).toContain('.');
    expect(expiresAt).toBe(NOW + DEFAULT_MEDIA_TOKEN_TTL_MS);
  });

  it('caps a long-lived request instead of refusing it', async () => {
    // رابط بلا انتهاء = رابط دائم للمحتوى. والرفض يجعل عميلًا قديمًا يفشل
    // بلا سبب ظاهر، فالسقف أفضل.
    const { expiresAt } = await signMediaPath({
      path: PATH,
      userId: 'u1',
      secret: SECRET,
      now: NOW,
      ttlMs: 30 * 86_400_000,
    });
    expect(expiresAt).toBe(NOW + MAX_MEDIA_TOKEN_TTL_MS);
  });

  it('never mints a token that is already dead', async () => {
    const { expiresAt } = await signMediaPath({
      path: PATH,
      userId: 'u1',
      secret: SECRET,
      now: NOW,
      ttlMs: -5,
    });
    expect(expiresAt).toBeGreaterThan(NOW);
  });
});

describe('verifyMediaToken', () => {
  const mint = (over: Record<string, unknown> = {}) =>
    signMediaPath({ path: PATH, userId: 'u1', secret: SECRET, now: NOW, ...over });

  it('accepts its own token for the same path', async () => {
    const { token } = await mint();
    const result = await verifyMediaToken({ token, path: PATH, secret: SECRET, now: NOW + 1_000 });
    expect(result.ok).toBe(true);
    expect(result.claim).toMatchObject({ path: PATH, userId: 'u1' });
  });

  it('refuses a token for another page', async () => {
    // تعديل رقم الصفحة في الرابط لا يفتح صفحة أخرى
    const { token } = await mint();
    const result = await verifyMediaToken({
      token,
      path: '/v1/media/page/book-1/5',
      secret: SECRET,
      now: NOW + 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('refuses a token for another chapter', async () => {
    const { token } = await mint();
    const result = await verifyMediaToken({
      token,
      path: '/v1/media/page/book-2/4',
      secret: SECRET,
      now: NOW + 1_000,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an expired token and says so', async () => {
    const { token, expiresAt } = await mint();
    const result = await verifyMediaToken({ token, path: PATH, secret: SECRET, now: expiresAt + 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
    // «صورة مكسورة» بلا سبب أسوأ شيء يمكن تشخيصه في قارئ
    expect(result.claim?.userId).toBe('u1');
  });

  it('refuses a token signed with another secret', async () => {
    const { token } = await mint();
    const result = await verifyMediaToken({
      token,
      path: PATH,
      secret: 'another-secret-that-is-also-long-enough!!',
      now: NOW + 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('refuses a token whose user was swapped', async () => {
    // الرأس غير موقَّع وحده؛ تبديل المستخدم يكسر التوقيع
    const { token } = await mint();
    const [, signature] = token.split('.');
    const forgedHead = btoa('u2\n' + String(NOW + 60_000))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const result = await verifyMediaToken({
      token: `${forgedHead}.${signature}`,
      path: PATH,
      secret: SECRET,
      now: NOW + 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('reports a bad signature before it reports an expiry', async () => {
    // الترتيب المعاكس يقول «انتهى» لتوقيع ملفَّق، فيتعلّم المهاجم أن المسار صحيح
    const result = await verifyMediaToken({
      token: `${btoa('u1\n1').replace(/=+$/, '')}.AAAA`,
      path: PATH,
      secret: SECRET,
      now: NOW,
    });
    expect(result.reason).toBe('bad_signature');
  });

  it('refuses a malformed token without throwing', async () => {
    for (const token of ['', 'nodot', '.', 'a.b', '%%%.%%%']) {
      const result = await verifyMediaToken({ token, path: PATH, secret: SECRET, now: NOW });
      expect(result.ok).toBe(false);
      expect(['malformed', 'bad_signature']).toContain(result.reason);
    }
  });

  it('gives two different paths two different tokens', async () => {
    const a = await mint();
    const b = await signMediaPath({
      path: '/v1/media/page/book-1/5',
      userId: 'u1',
      secret: SECRET,
      now: NOW,
    });
    expect(a.token).not.toBe(b.token);
  });
});

describe('mediaUrl', () => {
  it('builds a src an img tag can carry', async () => {
    const { token } = await signMediaPath({ path: PATH, userId: 'u1', secret: SECRET, now: NOW });
    const url = mediaUrl('https://api.example.com/', PATH, token);
    expect(url.startsWith('https://api.example.com/v1/media/page/book-1/4?t=')).toBe(true);
  });

  it('appends to a path that already has a query', async () => {
    const url = mediaUrl('https://api.example.com', '/v1/media/page/b/1?maxWidth=1100', 'tok');
    expect(url).toContain('?maxWidth=1100&t=tok');
  });
});
