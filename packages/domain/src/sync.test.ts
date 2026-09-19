import { describe, expect, it } from 'vitest';

import {
  COMPLETED_READ_RATIO,
  MAX_USAGE_OP_MS,
  MIN_COMPLETED_READ_MS,
  clampUsageCredit,
  dedupeOps,
  isCompletedRead,
  mergeFields,
  mergeProgress,
  needsFullResync,
  nextCursor,
  readStats,
  stripImmutable,
} from './sync.ts';

describe('nextCursor', () => {
  it('يأخذ أعلى rev في الدفعة', () => {
    expect(nextCursor([{ rev: 4 }, { rev: 9 }, { rev: 7 }], 3)).toBe(9);
  });

  it('لا يرجع بالـcursor عندما تكون الدفعة فارغة', () => {
    expect(nextCursor([], 12)).toBe(12);
  });

  it('لا يرجع بالـcursor عندما تحمل الدفعة revs أقدم', () => {
    // يحدث لو وصلت دفعة مُعاد تسليمها. الرجوع يعيد سحب كل شيء.
    expect(nextCursor([{ rev: 2 }], 12)).toBe(12);
  });
});

describe('needsFullResync', () => {
  it('يطلب سحبًا كاملًا عندما يسبق الـcursor عدّاد الخادم', () => {
    // D1 مُستعادة من نسخة احتياطية: بلا هذا الفحص لا يرى العميل جديدًا أبدًا
    expect(needsFullResync(500, 120)).toBe(true);
  });

  it('لا يطلب شيئًا في الحالة الطبيعية', () => {
    expect(needsFullResync(120, 120)).toBe(false);
    expect(needsFullResync(0, 120)).toBe(false);
  });
});

describe('dedupeOps', () => {
  it('يُسقط المكرّر ويحفظ الترتيب', () => {
    const ops = [
      { opId: 'a', n: 1 },
      { opId: 'b', n: 2 },
      { opId: 'a', n: 3 },
      { opId: 'c', n: 4 },
    ];
    expect(dedupeOps(ops).map((op) => op.opId)).toEqual(['a', 'b', 'c']);
    // تُحفظ أول نسخة لا الأخيرة
    expect(dedupeOps(ops)[0]?.n).toBe(1);
  });
});

describe('mergeProgress', () => {
  it('يكتب التقدم الأول كما هو', () => {
    expect(mergeProgress(null, { page: 12, ratio: 0.4 })).toEqual({ page: 12, ratio: 0.4 });
  });

  it('لا يُرجع التقدم للخلف عندما يزامن جهاز قديم', () => {
    // القاعدة التي تمنع «رجعت 18 صفحة بلا سبب»
    const merged = mergeProgress({ page: 30, ratio: 0.95 }, { page: 12, ratio: 0.4 });
    expect(merged).toEqual({ page: 30, ratio: 0.95 });
  });

  it('يتقدم عندما يكون الوارد أعلى', () => {
    expect(mergeProgress({ page: 12, ratio: 0.4 }, { page: 30, ratio: 0.95 })).toEqual({
      page: 30,
      ratio: 0.95,
    });
  });

  it('يدمج كل حقل مستقلًا', () => {
    // صفحات أُضيفت لفصل منشور: صفحة أعلى مع ratio أقل
    expect(mergeProgress({ page: 20, ratio: 0.9 }, { page: 24, ratio: 0.8 })).toEqual({
      page: 24,
      ratio: 0.9,
    });
  });

  it('يحدّ النسبة ويرفض الأرقام غير الصالحة', () => {
    expect(mergeProgress(null, { page: -5, ratio: 4 })).toEqual({ page: 0, ratio: 1 });
    expect(mergeProgress(null, { page: 3, ratio: Number.NaN })).toEqual({ page: 3, ratio: 0 });
  });
});

describe('isCompletedRead', () => {
  it('يرفض فتح الفصل لثانية', () => {
    expect(isCompletedRead({ ratio: 1, activeMs: 900 })).toBe(false);
  });

  it('يرفض النسبة الناقصة حتى مع وقت طويل', () => {
    expect(isCompletedRead({ ratio: 0.5, activeMs: 600_000 })).toBe(false);
  });

  it('يقبل النسبة والوقت معًا', () => {
    expect(
      isCompletedRead({ ratio: COMPLETED_READ_RATIO, activeMs: MIN_COMPLETED_READ_MS }),
    ).toBe(true);
  });
});

describe('clampUsageCredit', () => {
  it('يُسقط السالب وغير الرقم', () => {
    expect(clampUsageCredit(-1)).toBe(0);
    expect(clampUsageCredit(Number.NaN)).toBe(0);
  });

  it('يمرّر القيمة المعقولة', () => {
    expect(clampUsageCredit(95_000)).toBe(95_000);
  });

  it('يسقُف ما يرسله عميل معطوب', () => {
    expect(clampUsageCredit(40 * 3_600_000)).toBe(MAX_USAGE_OP_MS);
  });
});

describe('readStats', () => {
  it('يفصل الفصول الفريدة عن الإعادات', () => {
    // المثال المتفق عليه: 10 مرة، 11 مرة، 12 ثلاث مرات
    const stats = readStats([
      { chapterKey: 'ch-10', readCount: 1 },
      { chapterKey: 'ch-11', readCount: 1 },
      { chapterKey: 'ch-12', readCount: 3 },
    ]);
    expect(stats).toEqual({ uniqueChapters: 3, totalReads: 5, rereads: 2 });
  });

  it('لا يحتسب صفًا بلا قراءة مكتملة', () => {
    const stats = readStats([
      { chapterKey: 'ch-1', readCount: 0 },
      { chapterKey: 'ch-2', readCount: 2 },
    ]);
    expect(stats).toEqual({ uniqueChapters: 1, totalReads: 2, rereads: 1 });
  });

  it('صفر عند غياب أي قراءة', () => {
    expect(readStats([])).toEqual({ uniqueChapters: 0, totalReads: 0, rereads: 0 });
  });
});

describe('mergeFields', () => {
  it('لا يمسح تعديل جهاز آخر على حقل مختلف', () => {
    // جهاز غيّر الصورة وآخر غيّر النبذة: دمج الصف كله يفقد أحدهما
    const first = mergeFields(
      { avatar: 'old.png', bio: 'قديمة' },
      {},
      { avatar: 'new.png' },
      5,
    );
    const second = mergeFields(first.value, first.revs, { bio: 'جديدة' }, 6);
    expect(second.value).toEqual({ avatar: 'new.png', bio: 'جديدة' });
  });

  it('الأحدث يفوز في الحقل نفسه', () => {
    const first = mergeFields({ bio: 'أ' }, {}, { bio: 'ب' }, 4);
    const second = mergeFields(first.value, first.revs, { bio: 'ج' }, 9);
    expect(second.value.bio).toBe('ج');
  });

  it('الأقدم لا يفوز على الأحدث', () => {
    const first = mergeFields({ bio: 'أ' }, {}, { bio: 'ج' }, 9);
    const second = mergeFields(first.value, first.revs, { bio: 'ب' }, 4);
    expect(second.value.bio).toBe('ج');
  });

  it('إعادة تسليم نفس الـrev لا تغيّر شيئًا', () => {
    const first = mergeFields({ bio: 'أ' }, {}, { bio: 'ب' }, 7);
    const again = mergeFields(first.value, first.revs, { bio: 'ج' }, 7);
    expect(again.value.bio).toBe('ب');
  });

  it('لا يلمس حقلًا غائبًا عن الوارد', () => {
    const merged = mergeFields({ avatar: 'a.png', bio: 'ب' }, {}, { bio: 'ج' }, 3);
    expect(merged.value.avatar).toBe('a.png');
  });

  it('يطبّق الحذف الصريح', () => {
    const merged = mergeFields<{ banner: string | null }>(
      { banner: 'b.png' },
      {},
      { banner: null },
      3,
    );
    expect(merged.value.banner).toBeNull();
  });
});

describe('stripImmutable', () => {
  it('يُسقط الهوية الداخلية من أي تعديل وارد', () => {
    const patch = stripImmutable({
      user_id: 'مُلفَّق',
      userId: 'مُلفَّق',
      created_at: 1,
      displayName: 'دحمي',
    });
    expect(patch).toEqual({ displayName: 'دحمي' });
  });

  it('يمرّر التعديل المشروع كما هو', () => {
    expect(stripImmutable({ displayName: 'منصور', avatar: 'a.png' })).toEqual({
      displayName: 'منصور',
      avatar: 'a.png',
    });
  });
});
