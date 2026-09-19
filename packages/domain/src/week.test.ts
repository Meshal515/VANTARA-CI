/**
 * §32 — ملخص الأسبوع.
 *
 * السؤال هنا ليس «هل تجمع الدالة أرقامًا» بل: هل يرى الثلاثة نفس الملخص؟
 * وهل يظهر من لم يقرأ؟ وهل يتسرّب أسبوعٌ سابق إلى هذا؟
 */
import { describe, expect, it } from 'vitest';
import { summariseWeek, weekEnding, type WeekInput } from './week.ts';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const WINDOW = weekEnding(NOW);
const inside = NOW - 2 * 24 * 60 * 60 * 1000;
const before = WINDOW.from - 1;

const accounts = [
  { userId: 'u1', displayName: 'مشعل' },
  { userId: 'u2', displayName: 'منصور' },
  { userId: 'u3', displayName: 'NGM' },
];

const read = (userId: string, seriesRef: string, chapterKey: string, extra = {}) => ({
  userId,
  seriesRef,
  chapterKey,
  readCount: 1,
  lastReadAt: inside,
  ...extra,
});

const base = (over: Partial<WeekInput> = {}): WeekInput => ({ accounts, ...over });

describe('حدود المدى', () => {
  it('لا يحسب ما قُرئ قبل بداية الأسبوع', () => {
    const summary = summariseWeek(
      base({ reads: [read('u1', 's', 'c1', { lastReadAt: before })] }),
      WINDOW,
    );
    expect(summary.people.every((p) => p.chapters === 0)).toBe(true);
  });

  it('لا يتقاسم أسبوعان لحظة واحدة', () => {
    // `to` غير شامل: فصلٌ عند الحدّ يخصّ الأسبوع التالي لا هذا
    const summary = summariseWeek(base({ reads: [read('u1', 's', 'c1', { lastReadAt: WINDOW.to })] }), WINDOW);
    expect(summary.people[0].chapters).toBe(0);
  });

  it('يتجاهل يومًا بصيغة تالفة بدل أن يسقط', () => {
    const summary = summariseWeek(base({ days: [{ userId: 'u1', day: 'امس', activeMs: 900 }] }), WINDOW);
    expect(summary.people.every((p) => p.activeMs === 0)).toBe(true);
  });
});

describe('سطر كل شخص', () => {
  it('يعرض الثلاثة حتى من لم يقرأ', () => {
    // §32 يعرض ثلاثة أسطر؛ وإخفاء من لم يقرأ يجعل الغياب عقوبة
    const summary = summariseWeek(base({ reads: [read('u1', 's', 'c1')] }), WINDOW);
    expect(summary.people).toHaveLength(3);
    // وجودًا لا ترتيبًا: ترتيب العرض تحكمه الفصول، وقد اختُبر وحده
    expect(new Set(summary.people.map((p) => p.displayName))).toEqual(
      new Set(['مشعل', 'منصور', 'NGM']),
    );
  });

  it('يعدّ الفصول ويسمّي أكثر عمل قُرئ', () => {
    const summary = summariseWeek(
      base({
        reads: [read('u1', 'kingdom', 'c1'), read('u1', 'kingdom', 'c2'), read('u1', 'other', 'c3')],
      }),
      WINDOW,
    );
    const me = summary.people.find((p) => p.userId === 'u1')!;
    expect(me.chapters).toBe(3);
    expect(me.topSeries).toBe('kingdom');
  });

  it('يعدّ الإعادة بعدّاد الفصل لا بتاريخه', () => {
    const summary = summariseWeek(base({ reads: [read('u1', 's', 'c1', { readCount: 3 })] }), WINDOW);
    expect(summary.people.find((p) => p.userId === 'u1')!.rereads).toBe(1);
  });

  it('يجمع زمن النشاط من الأيام داخل المدى وحدها', () => {
    const day = new Date(inside).toISOString().slice(0, 10);
    const summary = summariseWeek(
      base({
        days: [
          { userId: 'u1', day, activeMs: 1000 },
          { userId: 'u1', day: '2001-01-01', activeMs: 9999 },
        ],
      }),
      WINDOW,
    );
    expect(summary.people.find((p) => p.userId === 'u1')!.activeMs).toBe(1000);
  });

  it('يرتّب بالفصول تنازليًّا ويكسر التعادل بثبات', () => {
    const summary = summariseWeek(
      base({ reads: [read('u2', 's', 'a'), read('u2', 's', 'b'), read('u3', 's', 'c')] }),
      WINDOW,
    );
    expect(summary.people.map((p) => p.userId)).toEqual(['u2', 'u3', 'u1']);
  });
});

describe('اللحظات المرحة', () => {
  it('لا يعلن «أكثر واحد قرأ» في أسبوع لم يقرأ فيه أحد', () => {
    // إعلان فائزٍ بصفر فصل يجعل الملخص كذبًا مرحًا
    expect(summariseWeek(base(), WINDOW).moments).toEqual([]);
  });

  it('يعلن الأكثر قراءةً والأكثر إعادة', () => {
    const summary = summariseWeek(
      base({
        reads: [read('u1', 's', 'a'), read('u1', 's', 'b'), read('u2', 's', 'c', { readCount: 2 })],
      }),
      WINDOW,
    );
    expect(summary.moments).toContainEqual({ kind: 'MOST_READ', userId: 'u1', chapters: 2 });
    expect(summary.moments).toContainEqual({ kind: 'MOST_REREAD', userId: 'u2', rereads: 1 });
  });

  it('«العمل الذي قرأه الجميع» يعني الجميع لا أغلبهم', () => {
    const two = base({ reads: [read('u1', 'shared', 'a'), read('u2', 'shared', 'b')] });
    expect(summariseWeek(two, WINDOW).moments.some((m) => m.kind === 'SHARED_WORK')).toBe(false);

    const all = base({
      reads: [read('u1', 'shared', 'a'), read('u2', 'shared', 'b'), read('u3', 'shared', 'c')],
    });
    expect(summariseWeek(all, WINDOW).moments).toContainEqual({
      kind: 'SHARED_WORK',
      seriesRef: 'shared',
    });
  });

  it('يلتقط أقلّ تقييم في المدى', () => {
    const summary = summariseWeek(
      base({
        ratings: [
          { userId: 'u1', seriesRef: 'good', score: 9, updatedAt: inside },
          { userId: 'u3', seriesRef: 'bad', score: 2, updatedAt: inside },
          { userId: 'u2', seriesRef: 'older', score: 1, updatedAt: before },
        ],
      }),
      WINDOW,
    );
    expect(summary.moments).toContainEqual({
      kind: 'LOWEST_RATING',
      userId: 'u3',
      seriesRef: 'bad',
      score: 2,
    });
  });

  it('يعطي نفس الملخص لنفس المدخلات مهما تبدّل ترتيبها', () => {
    // الثلاثة يفتحونه على أجهزة مختلفة؛ ملخصان مختلفان يفسدان النكتة
    const reads = [read('u1', 'a', '1'), read('u2', 'a', '2'), read('u3', 'a', '3')];
    const forward = summariseWeek(base({ reads }), WINDOW);
    const backward = summariseWeek(base({ reads: [...reads].reverse() }), WINDOW);
    expect(backward).toEqual(forward);
  });
});
