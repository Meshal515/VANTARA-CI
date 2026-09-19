/**
 * الحرق اليدوي.
 *
 * النموذج الأول ربط الحجب بتقدّم القارئ داخل VANTARA، وأسقطه المالك بسببٍ
 * صحيح: الواحد قد يكون أنهى العمل كله في موقع آخر قبل أن ينتقل إلى التطبيق،
 * فعدّادنا يحجب عنه ما قرأه ويكشف لغيره ما لم يقرأه. القرار عند من يعرف:
 * كاتب التعليق.
 */
import { describe, expect, it } from 'vitest';
import { commentVeiled, fanoutBody, isSpoiler } from './spoilers.ts';

describe('a spoiler is what its author marked', () => {
  it('reads the flag D1 actually returns', () => {
    // SQLite لا تعرف boolean: الصفّ يرجع 0 أو 1
    expect(isSpoiler(1)).toBe(true);
    expect(isSpoiler(0)).toBe(false);
    expect(isSpoiler(true)).toBe(true);
    expect(isSpoiler(null)).toBe(false);
    expect(isSpoiler(undefined)).toBe(false);
  });

  it('does not treat a stray string as a spoiler', () => {
    // حمولة مشوَّهة لا تصنع حرقًا، ولا تُسقط حرقًا موجودًا
    expect(isSpoiler('true')).toBe(false);
    expect(isSpoiler('1')).toBe(false);
  });
});

describe('text that may travel to a surface with no reveal control', () => {
  it('withholds a spoiler body from notifications and activity', () => {
    // الإشعار لا زرّ كشف فيه: الحرق يقع بمجرد العرض
    expect(fanoutBody({ body: 'مات في الفصل 500', spoiler: true })).toBeNull();
  });

  it('carries an ordinary body through', () => {
    expect(fanoutBody({ body: 'ردّ عليك', spoiler: false })).toBe('ردّ عليك');
  });

  it('withholds it whatever the flag arrived as', () => {
    // الحارس هنا هو الفرق بين إشعارٍ آمن وإشعارٍ يحرق
    expect(fanoutBody({ body: 'x', spoiler: isSpoiler(1) })).toBeNull();
  });
});

describe('what the reader sees before consenting', () => {
  it('veils a spoiler until this reader reveals it', () => {
    expect(commentVeiled({ spoiler: true, revealed: false })).toBe(true);
    expect(commentVeiled({ spoiler: true, revealed: true })).toBe(false);
  });

  it('never veils a comment its author did not mark', () => {
    expect(commentVeiled({ spoiler: false, revealed: false })).toBe(false);
  });

  it('ignores a reveal for something that was never a spoiler', () => {
    // كشفٌ قديم محفوظ محليًّا لا يجوز أن يغيّر شيئًا في تعليق عادي
    expect(commentVeiled({ spoiler: false, revealed: true })).toBe(false);
  });
});
