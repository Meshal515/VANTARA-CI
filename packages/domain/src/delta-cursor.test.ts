/**
 * المؤشر بعد دفعة مقطوعة.
 *
 * السقف يُطبَّق **لكل جدول**، والمؤشر رقم **واحد** مشترك. فإن حُسب المؤشر من
 * أعلى rev في كل الجداول، سحبه جدولٌ بعيدٌ فوق ما لم يُسلَّم من جدول مقطوع،
 * وضاعت صفوفه للأبد بلا أي أثر: العميل يسمع «أنت محدَّث» وهو ناقص.
 *
 * أُثبت على D1 حقيقية قبل هذا الملف: 600 صفّ نشاط، الجولة الأولى تسلّم 500
 * وتقفز بالمؤشر إلى جدول آخر عند 2000، والجولة الثانية ترجع صفرًا و
 * `more:false`. مئة صفّ لا تصل أي جهاز أبدًا.
 */
import { describe, expect, it } from 'vitest';
import { nextDeltaCursor } from './sync.ts';

describe('the delta cursor after a capped page', () => {
  it('never passes a capped table just because another table is further ahead', () => {
    // `activity` مقطوع عند 1499، و`settings` عند 2000
    const { cursor, more } = nextDeltaCursor(
      [
        { truncated: true, maxRev: 1499 },
        { truncated: false, maxRev: 2000 },
      ],
      { cursor: 0, serverRev: 2000 },
    );

    expect(cursor).toBe(1499);
    expect(more).toBe(true);
  });

  it('stops at the earliest capped table when several are capped', () => {
    // جدولان مقطوعان: الأمان هو الأصغر، وإلا فُقد ما بين الاثنين
    const { cursor } = nextDeltaCursor(
      [
        { truncated: true, maxRev: 900 },
        { truncated: true, maxRev: 1400 },
        { truncated: false, maxRev: 2000 },
      ],
      { cursor: 0, serverRev: 2000 },
    );

    expect(cursor).toBe(900);
  });

  it('jumps to the server revision when nothing was capped', () => {
    // لا قطع: المؤشر يلحق عدّاد الخادم حتى لا يُعاد سحب ما لا جديد فيه
    const { cursor, more } = nextDeltaCursor(
      [
        { truncated: false, maxRev: 12 },
        { truncated: false, maxRev: 40 },
      ],
      { cursor: 5, serverRev: 97 },
    );

    expect(cursor).toBe(97);
    expect(more).toBe(false);
  });

  it('never moves the cursor backwards', () => {
    // دفعة فارغة تعني «لا جديد»، لا «ابدأ من الصفر»
    const { cursor } = nextDeltaCursor([], { cursor: 640, serverRev: 640 });
    expect(cursor).toBe(640);
  });

  it('never reports a cursor a capped page did not reach', () => {
    // حراسة: المؤشر بعد قطعٍ لا يجوز أن يتجاوز أصغر جدول مقطوع مهما كان
    // `serverRev`، فالأسرار كلها في هذا الفرق
    const { cursor } = nextDeltaCursor([{ truncated: true, maxRev: 300 }], {
      cursor: 0,
      serverRev: 999_999,
    });

    expect(cursor).toBe(300);
  });

  it('keeps asking for more while a capped table still has rows', () => {
    const { more } = nextDeltaCursor([{ truncated: true, maxRev: 300 }], {
      cursor: 0,
      serverRev: 300,
    });
    expect(more).toBe(true);
  });
});
