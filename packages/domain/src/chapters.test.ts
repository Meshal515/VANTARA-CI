import { describe, expect, it } from 'vitest';

import {
  auditCoverage,
  buildCatalogue,
  latestReadable,
  nextReadable,
  pickCopy,
  resumePoint,
  type ChapterCopy,
} from './chapters.ts';

const copy = (over: Partial<ChapterCopy> = {}): ChapterCopy => ({
  key: over.key ?? `${over.source ?? 'src'}:1`,
  source: over.source ?? 'src',
  lang: over.lang ?? 'ar',
  pages: over.pages ?? 20,
  chosen: over.chosen ?? false,
  blocked: over.blocked ?? false,
  onDisk: over.onDisk ?? false,
  ...over,
});

describe('buildCatalogue', () => {
  it('يجمع المحمول والأشباح في قائمة واحدة مرتّبة', () => {
    const entries = buildCatalogue({
      held: [{ id: 'b3', number: 3 }],
      ghosts: [
        { number: 1, why: 'missing' },
        { number: 2, why: 'missing' },
      ],
    });
    expect(entries.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.state)).toEqual(['MISSING', 'MISSING', 'ON_DISK']);
    expect(entries[2]?.bookId).toBe('b3');
  });

  it('المحمول يغلب الشبح لنفس الرقم', () => {
    // يحدث بين sweep وجلب: الرقم في القائمتين معًا
    const entries = buildCatalogue({
      held: [{ id: 'b7', number: 7 }],
      ghosts: [{ number: 7, why: 'failed', attempts: 3 }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toBe('ON_DISK');
    expect(entries[0]?.why).toBeUndefined();
  });

  it('يحفظ سبب الغياب بدل أن يوحّده', () => {
    const entries = buildCatalogue({
      ghosts: [
        { number: 1, why: 'floor' },
        { number: 2, why: 'blocked' },
        { number: 3, why: 'held', waitingFor: 'فريق أ', waitDaysLeft: 2 },
        { number: 4, why: 'failed', attempts: 5 },
      ],
    });
    expect(entries.map((e) => e.state)).toEqual(['BELOW_FLOOR', 'BLOCKED', 'HELD', 'FAILED']);
    expect(entries[2]?.waitDaysLeft).toBe(2);
    expect(entries[3]?.attempts).toBe(5);
  });

  it('يُبقي رقمًا ظهر في النسخ وحدها', () => {
    // أرقام فُحصت بعد آخر sweep: لا شبح لها ولا صفّ محمول
    const entries = buildCatalogue({
      versions: [{ number: 12, copies: [copy({ source: 'a' })] }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.readable).toBe(true);
  });

  it('يوحّد الفوارق العشرية فلا يصير الفصل فصلين', () => {
    const entries = buildCatalogue({
      ghosts: [{ number: 12.5, why: 'missing' }],
      versions: [{ number: 12.499999, copies: [copy()] }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.number).toBe(12.5);
  });

  it('الرابط الخارجي وحده يجعل الفصل غير قابل للقراءة', () => {
    const entries = buildCatalogue({
      ghosts: [
        { number: 1, why: 'missing' },
        { number: 2, why: 'missing' },
      ],
      versions: [
        { number: 1, copies: [copy({ key: 'x:2', pages: 0 })] },
        { number: 2, copies: [copy({ key: 'y:1' })] },
      ],
    });
    expect(entries[0]?.readable).toBe(false);
    expect(entries[1]?.readable).toBe(true);
  });

  it('المحجوب يبقى قابلًا للقراءة: الاختيار الصريح يتجاوز الحجب', () => {
    // `picks` في العقد تتجاوز قواعد المجموعات، فمجموعة محجوبة لا تُخفي فصلًا
    const entries = buildCatalogue({
      ghosts: [{ number: 1, why: 'blocked' }],
      versions: [{ number: 1, copies: [copy({ blocked: true })] }],
    });
    expect(entries[0]?.state).toBe('BLOCKED');
    expect(entries[0]?.readable).toBe(true);
  });
});

describe('auditCoverage', () => {
  it('يكشف الفراغ الذي وصفه المستخدم: 1–60 ثم 200–400', () => {
    // الأعراض بالحرف: أول ستين فصلًا، قفزة، ثم توقّف قبل النهاية
    const ghosts = [
      ...Array.from({ length: 60 }, (_, i) => ({ number: i + 1, why: 'missing' as const })),
      ...Array.from({ length: 201 }, (_, i) => ({ number: i + 200, why: 'missing' as const })),
    ];
    const report = auditCoverage(buildCatalogue({ ghosts }));
    expect(report.first).toBe(1);
    expect(report.last).toBe(400);
    expect(report.complete).toBe(false);
    // 61..199 غائبة تمامًا
    expect(report.missing).toHaveLength(139);
    expect(report.missing[0]).toBe(61);
    expect(report.missing.at(-1)).toBe(199);
  });

  it('يقول كامل عندما لا ينقص رقم', () => {
    const report = auditCoverage(
      buildCatalogue({
        ghosts: Array.from({ length: 700 }, (_, i) => ({ number: i + 1, why: 'missing' as const })),
      }),
    );
    expect(report).toMatchObject({ first: 1, last: 700, expected: 700, present: 700, complete: true });
  });

  it('لا يعدّ فصلًا غير منزّل فراغًا', () => {
    // الفرق الحاكم: معروض وغير منزّل يُجلب عند فتحه، وليس نقصًا
    const report = auditCoverage(
      buildCatalogue({
        held: [{ id: 'b1', number: 1 }],
        ghosts: [
          { number: 2, why: 'missing' },
          { number: 3, why: 'missing' },
        ],
      }),
    );
    expect(report.complete).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('يحترم عملًا يبدأ من صفر', () => {
    const report = auditCoverage(
      buildCatalogue({ ghosts: [0, 1, 2].map((n) => ({ number: n, why: 'missing' as const })) }),
    );
    expect(report.first).toBe(0);
    expect(report.expected).toBe(3);
    expect(report.complete).toBe(true);
  });

  it('الفصول الإضافية العشرية لا تخترع فراغًا', () => {
    const report = auditCoverage(
      buildCatalogue({
        ghosts: [
          { number: 1, why: 'missing' },
          { number: 1.5, why: 'missing' },
          { number: 2, why: 'missing' },
        ],
      }),
    );
    expect(report.complete).toBe(true);
    expect(report.expected).toBe(2);
  });

  it('يفصل المستثنى بقرار عن الفراغ', () => {
    const report = auditCoverage(
      buildCatalogue({
        ghosts: [
          { number: 1, why: 'floor' },
          { number: 2, why: 'blocked' },
          { number: 3, why: 'missing' },
        ],
      }),
    );
    // كلها معروضة فلا فراغ، لكن اثنان مستثنيان بقرار لا بعطل
    expect(report.missing).toEqual([]);
    expect(report.withheld).toEqual([1, 2]);
  });

  it('عمل بلا فصول لا يُبلّغ عن نقص', () => {
    expect(auditCoverage([])).toMatchObject({ first: null, complete: true, missing: [] });
  });
});

describe('pickCopy', () => {
  it('يُفضّل الموجود على القرص', () => {
    const chosen = pickCopy([
      copy({ key: 'a:1', chosen: true, pages: 40 }),
      copy({ key: 'b:1', onDisk: true, pages: 10 }),
    ]);
    expect(chosen?.key).toBe('b:1');
  });

  it('ثم ما اختارته قواعد الإصدار', () => {
    const chosen = pickCopy([copy({ key: 'a:1' }), copy({ key: 'b:1', chosen: true })]);
    expect(chosen?.key).toBe('b:1');
  });

  it('ثم اللغة المفضّلة', () => {
    const chosen = pickCopy([copy({ key: 'en:1', lang: 'en' }), copy({ key: 'ar:1', lang: 'ar' })]);
    expect(chosen?.key).toBe('ar:1');
  });

  it('ثم الأكثر صفحات: النسخة المبتورة ليست خيارًا', () => {
    const chosen = pickCopy([copy({ key: 'a:1', pages: 3 }), copy({ key: 'b:1', pages: 24 })]);
    expect(chosen?.key).toBe('b:1');
  });

  it('يستبعد الرابط الخارجي وحده', () => {
    expect(pickCopy([copy({ key: 'x:1', pages: 0 })])).toBeNull();
  });

  it('يؤخّر المحجوب ولا يستبعده', () => {
    const chosen = pickCopy([copy({ key: 'a:1', blocked: true }), copy({ key: 'b:1' })]);
    expect(chosen?.key).toBe('b:1');
    // وحده ⇒ يُختار: أفضل من فصل لا يُفتح
    expect(pickCopy([copy({ key: 'a:1', blocked: true })])?.key).toBe('a:1');
  });

  it('يبدّل المصدر عندما تُستثنى النسخة الفاشلة', () => {
    // هذا ما يجعل الفصل التالف لا يوقف القراءة
    const copies = [copy({ key: 'a:1', chosen: true }), copy({ key: 'b:1' })];
    expect(pickCopy(copies)?.key).toBe('a:1');
    expect(pickCopy(copies, { exclude: new Set(['a:1']) })?.key).toBe('b:1');
    expect(pickCopy(copies, { exclude: new Set(['a:1', 'b:1']) })).toBeNull();
  });
});

describe('reading order', () => {
  const entries = buildCatalogue({
    held: [
      { id: 'b1', number: 1, read: true },
      { id: 'b2', number: 2, read: true },
      { id: 'b4', number: 4 },
    ],
    ghosts: [{ number: 3, why: 'blocked' }],
  });

  it('يتخطّى ما لا يُقرأ عند الانتقال للفصل التالي', () => {
    // 3 محجوب: القارئ المتصل يمرّ إلى 4 بدل أن يتوقف
    expect(nextReadable(entries, 2)?.number).toBe(4);
  });

  it('لا فصل بعد الأخير', () => {
    expect(nextReadable(entries, 4)).toBeNull();
  });

  it('أحدث فصل قابل للقراءة', () => {
    expect(latestReadable(entries)?.number).toBe(4);
  });

  it('الاستكمال يفتح أول غير مقروء', () => {
    expect(resumePoint(entries)?.number).toBe(4);
  });

  it('الاستكمال يفتح الأول لمن لم يبدأ', () => {
    const fresh = buildCatalogue({ held: [{ id: 'b1', number: 1 }, { id: 'b2', number: 2 }] });
    expect(resumePoint(fresh)?.number).toBe(1);
  });

  it('الاستكمال يبقى على الأخير لمن أنهى كل شيء', () => {
    const done = buildCatalogue({
      held: [
        { id: 'b1', number: 1, read: true },
        { id: 'b2', number: 2, read: true },
      ],
    });
    expect(resumePoint(done)?.number).toBe(2);
  });
});
