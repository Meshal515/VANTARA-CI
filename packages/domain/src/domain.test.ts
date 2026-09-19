import { describe, expect, it } from 'vitest';
import {
  MAX_BEAT_CREDIT_MS,
  compareChapters,
  containsSecret,
  creditForBeat,
  looksRelevant,
  redactForViewers,
  scrubDiagnostics,
  statusFor,
  usableForReading,
  usableForSearch,
  verdictFrom,
  type ProbeEvidence,
} from './index.ts';

const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });

function evidence(overrides: Partial<ProbeEvidence> = {}): ProbeEvidence {
  return {
    popular: ok({ count: 20 }),
    search: ok({ count: 1, relevant: true }),
    chapters: ok({ count: 332 }),
    pagesOldest: ok({ count: 40 }),
    pagesNewest: ok({ count: 22 }),
    imagesDecoded: ok({ types: ['JPEG'] }),
    ...overrides,
  } as ProbeEvidence;
}

describe('reading time', () => {
  it('credits a visible, interacting beat', () => {
    expect(creditForBeat({ visible: true, interactions: 3 }, 25_000)).toBe(25_000);
  });

  it('credits nothing for a hidden tab', () => {
    expect(creditForBeat({ visible: false, interactions: 9 }, 25_000)).toBe(0);
  });

  it('credits nothing without interaction — an open tab is not reading', () => {
    expect(creditForBeat({ visible: true, interactions: 0 }, 25_000)).toBe(0);
  });

  it('caps a long gap so a sleeping laptop is not counted as reading', () => {
    expect(creditForBeat({ visible: true, interactions: 2 }, 3_600_000)).toBe(MAX_BEAT_CREDIT_MS);
  });

  it('credits nothing for a replayed or backwards beat', () => {
    expect(creditForBeat({ visible: true, interactions: 2 }, 0)).toBe(0);
    expect(creditForBeat({ visible: true, interactions: 2 }, -5_000)).toBe(0);
  });
});

describe('presence status', () => {
  it('reports READING only while a work is open', () => {
    expect(statusFor(1_000, { reading: true })).toBe('READING');
    expect(statusFor(1_000, { reading: false })).toBe('ONLINE');
  });

  it('decays to IDLE then OFFLINE', () => {
    expect(statusFor(120_000, { reading: true })).toBe('IDLE');
    expect(statusFor(600_000, { reading: true })).toBe('OFFLINE');
  });

  it('hides the work but keeps presence while incognito', () => {
    const redacted = redactForViewers(
      {
        userId: 'u1',
        username: 'mansour',
        status: 'READING',
        seriesTitle: 'Nano Machine',
        chapterLabel: '184',
        progress: 0.63,
      },
      { incognito: true },
    );
    expect(redacted).toEqual({ userId: 'u1', username: 'mansour', status: 'ONLINE' });
  });

  it('leaves presence untouched when not incognito', () => {
    const full = {
      userId: 'u1',
      username: 'mansour',
      status: 'READING' as const,
      seriesTitle: 'Nano Machine',
    };
    expect(redactForViewers(full, { incognito: false })).toEqual(full);
  });
});

describe('source verdict', () => {
  it('returns SUPPORTED only when every probe passes', () => {
    expect(verdictFrom(evidence())).toBe('SUPPORTED');
  });

  it('diagnoses Cloudflare before anything else, since it is fixable', () => {
    const v = verdictFrom(
      evidence({ chapters: { ok: false, error: 'Cloudflare bypass currently disabled' } }),
    );
    expect(v).toBe('NEEDS_FLARESOLVERR');
  });

  it('calls a live source with useless search SEARCH_BROKEN, not failed', () => {
    // الحالة التي كشفها الـspike: Team X و3asq يخدمان POPULAR وبحثهما بلا صلة
    const v = verdictFrom(evidence({ search: { ok: true, count: 11, relevant: false } }));
    expect(v).toBe('SEARCH_BROKEN');
  });

  it('treats a search with no relevance verdict as broken, not supported', () => {
    expect(verdictFrom(evidence({ search: { ok: true, count: 3 } }))).toBe('SEARCH_BROKEN');
  });

  it('fails a source that is not alive at all', () => {
    const v = verdictFrom(
      evidence({ popular: { ok: false, error: 'timeout' }, search: { ok: false, error: 'timeout' } }),
    );
    expect(v).toBe('PARSER_FAILED');
  });

  it('fails when the newest chapter has no pages even if the oldest does', () => {
    expect(verdictFrom(evidence({ pagesNewest: { ok: false, error: '404' } }))).toBe('PARSER_FAILED');
  });

  it('fails when images do not decode, whatever the headers said', () => {
    expect(verdictFrom(evidence({ imagesDecoded: { ok: false, error: 'got HTML' } }))).toBe(
      'PARSER_FAILED',
    );
  });

  it('lets a SEARCH_BROKEN source still serve pages but not discovery', () => {
    expect(usableForReading('SEARCH_BROKEN')).toBe(true);
    expect(usableForSearch('SEARCH_BROKEN')).toBe(false);
    expect(usableForReading('PARSER_FAILED')).toBe(false);
    expect(usableForReading('POLICY_BLOCKED')).toBe(false);
  });
});

describe('search relevance', () => {
  it('accepts a title that contains the query terms', () => {
    expect(looksRelevant('nano machine', ['Nano Machine', 'Other'])).toBe(true);
  });

  it('rejects the noise a broken source returns', () => {
    expect(
      looksRelevant('nano machine', [
        'The Delusional Hunter in Another World',
        'Tang Yin in another world',
      ]),
    ).toBe(false);
  });

  it('matches Arabic titles and ignores diacritics', () => {
    expect(looksRelevant('نانو ماشين', ['نانو ماشين'])).toBe(true);
    expect(looksRelevant('نَانو', ['نانو ماشين'])).toBe(true);
  });

  it('rejects an empty query rather than matching everything', () => {
    expect(looksRelevant('', ['anything'])).toBe(false);
  });
});

describe('chapter ordering', () => {
  it('orders decimals and specials without treating numbers as plain floats', () => {
    const sorted = [
      { number: 10.1, kind: 'numbered' as const },
      { number: 1, kind: 'numbered' as const },
      { kind: 'prologue' as const },
      { number: 1.5, kind: 'numbered' as const },
      { number: 0, kind: 'numbered' as const },
      { kind: 'epilogue' as const },
      { number: 1, kind: 'special' as const },
    ].sort(compareChapters);

    expect(sorted.map((c) => `${c.kind}:${String(c.number ?? '-')}`)).toEqual([
      'prologue:-',
      'numbered:0',
      'numbered:1',
      'special:1',
      'numbered:1.5',
      'numbered:10.1',
      'epilogue:-',
    ]);
  });
});

describe('diagnostics scrubbing', () => {
  it('redacts the signature out of a signed page URL', () => {
    // بلاغ «صفحة ناقصة» يحمل رابط الصفحة بطبيعته. ورابطنا الموقَّع هو
    // `?t=<hmac>`: مفتاحه `t` ليس محظورًا، وقيمته سداسية بلا نقاط فلا
    // يمسكها نمط JWT. فكانت قدرةُ فتح الصفحة تُخزَّن في جدول البلاغات.
    const signed =
      '/v1/media/page/src%3Atest%3Ax/7?t=9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';
    const scrubbed = scrubDiagnostics({ lastImage: signed }) as { lastImage: string };
    expect(scrubbed.lastImage).not.toContain('9f8e7d6c5b4a');
    expect(scrubbed.lastImage).toContain('/v1/media/page/');
  });

  it('flags a leftover page signature as a secret', () => {
    expect(
      containsSecret({ url: '/v1/media/page/x/1?t=deadbeefdeadbeefdeadbeefdeadbeef1234' }),
    ).toBe(true);
  });

  it('drops forbidden keys and redacts secrets inside free text', () => {
    const scrubbed = scrubDiagnostics({
      appVersion: '0.1.0',
      cookie: 'session=abc',
      Authorization: 'Bearer uy_secretvalue12345678',
      nested: { apiKey: 'k', note: 'my token uy_anothersecret123456 here' },
    });

    const dump = JSON.stringify(scrubbed);
    expect(dump).toContain('0.1.0');
    expect(dump).not.toContain('session=abc');
    expect(dump).not.toContain('uy_secretvalue12345678');
    expect(dump).not.toContain('uy_anothersecret123456');
    expect(containsSecret(scrubbed)).toBe(false);
  });

  it('redacts a JWT that appears in a message body', () => {
    const scrubbed = scrubDiagnostics({
      message: 'failed with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij.klmnopqrst',
    });
    expect(JSON.stringify(scrubbed)).not.toContain('eyJhbGciOiJIUzI1NiIs');
  });

  it('survives a cyclic object instead of hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => scrubDiagnostics(cyclic)).not.toThrow();
    expect(() => containsSecret(cyclic)).not.toThrow();
  });

  it('flags an unscrubbed payload so nothing unsafe is stored', () => {
    expect(containsSecret({ note: 'uy_thisisdefinitelyasecret999' })).toBe(true);
  });
});
