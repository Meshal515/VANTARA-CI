import { describe, expect, it } from 'vitest';
import type { ChapterCopy } from '@vantara/domain';
import * as library from '../routes/library.ts';

const first: ChapterCopy = {
  key: 'source-a:chapter-a',
  source: 'source-a',
  chosen: true,
  pages: 20,
};
const second: ChapterCopy = {
  key: 'source-b:chapter-b',
  source: 'source-b',
  pages: 18,
};

type FallbackOptions = {
  copies: ChapterCopy[];
  fetchCopy: (copy: ChapterCopy | null) => Promise<unknown>;
  verifyAvailable: (copy: ChapterCopy | null) => Promise<boolean>;
  budgetMs?: number;
  now?: () => number;
};
type FallbackResult = { chosen: string | null; attempts: number };
type FallbackFn = (options: FallbackOptions) => Promise<FallbackResult>;

function fallbackFn(): FallbackFn | null {
  const candidate = (library as Record<string, unknown>)['fetchChapterWithFallback'];
  return typeof candidate === 'function' ? (candidate as FallbackFn) : null;
}

describe('fetchChapterWithFallback', () => {
  it('automatically tries the next copy when the preferred source throws', async () => {
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();
    if (!fetchChapterWithFallback) return;

    const attempts: string[] = [];
    const result = await fetchChapterWithFallback({
      copies: [first, second],
      fetchCopy: async (copy) => {
        attempts.push(copy?.key ?? 'automatic');
        if (copy?.key === first.key) throw new Error('source down');
        return { queued: true };
      },
      verifyAvailable: async (copy) => copy?.key === second.key,
    });

    expect(attempts).toEqual([first.key, second.key]);
    expect(result.chosen).toBe(second.key);
    expect(result.attempts).toBe(2);
  });

  it('moves on when a fetch call succeeds but the requested chapter never appears', async () => {
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();
    if (!fetchChapterWithFallback) return;

    const attempts: string[] = [];
    const result = await fetchChapterWithFallback({
      copies: [first, second],
      fetchCopy: async (copy) => {
        attempts.push(copy?.key ?? 'automatic');
        return { queued: true };
      },
      verifyAvailable: async (copy) => copy?.key === second.key,
    });

    expect(attempts).toEqual([first.key, second.key]);
    expect(result.chosen).toBe(second.key);
  });

  it('uses upstream automatic selection once when no copy metadata exists', async () => {
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();
    if (!fetchChapterWithFallback) return;

    let calls = 0;
    const result = await fetchChapterWithFallback({
      copies: [],
      fetchCopy: async (copy) => {
        calls += 1;
        expect(copy).toBeNull();
        return { queued: true };
      },
      verifyAvailable: async () => true,
    });

    expect(calls).toBe(1);
    expect(result.chosen).toBeNull();
    expect(result.attempts).toBe(1);
  });

  it('fails with a stable user-facing code only after every known copy is exhausted', async () => {
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();
    if (!fetchChapterWithFallback) return;

    await expect(
      fetchChapterWithFallback({
        copies: [first, second],
        fetchCopy: async () => {
          throw new Error('down');
        },
        verifyAvailable: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'chapter_unavailable', attempts: 2 });
  });
});

/**
 * الميزانية الزمنية.
 *
 * VANTARA خلف Cloudflare Tunnel، وCloudflare يقطع عند 100 ثانية (‏524). فحلقة
 * تبديل بلا سقف تعني: عملٌ بخمس نسخ مكسورة يطحن دقائق، والقارئ يرى «خطأ شبكة»
 * غامضًا بدل `chapter_unavailable`، والخادم يكمل العمل لأحدٍ انصرف.
 */
describe('fetchChapterWithFallback time budget', () => {
  const copiesOf = (count: number): ChapterCopy[] =>
    Array.from({ length: count }, (_, index) => ({
      key: `source-${index}:chapter-${index}`,
      source: `source-${index}`,
      pages: 20 - index,
    }));

  it('stops trying copies once the budget is spent', async () => {
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();

    // ساعة مُتحكَّم بها: كل محاولة تكلّف 40 ثانية، والميزانية 75
    let clock = 0;
    const tried: (string | null)[] = [];

    await expect(
      fetchChapterWithFallback!({
        copies: copiesOf(5),
        budgetMs: 75_000,
        now: () => clock,
        fetchCopy: async (copy) => {
          tried.push(copy?.key ?? null);
          clock += 40_000;
        },
        verifyAvailable: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'chapter_unavailable' });

    // محاولتان (0s و40s)، والثالثة كانت ستبدأ عند 80s — بعد النفاد
    expect(tried).toHaveLength(2);
  });

  it('always gives the first copy a chance, however small the budget', async () => {
    // ميزانية منتهية عند الدخول يجب ألا تعني «لم نحاول أصلًا»
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();

    let calls = 0;
    const result = await fetchChapterWithFallback!({
      copies: copiesOf(3),
      budgetMs: 0,
      now: () => 0,
      fetchCopy: async () => {
        calls += 1;
      },
      verifyAvailable: async () => true,
    });

    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('keeps trying every copy when the attempts are fast', async () => {
    // السقف حدّ للحالة المرضية، لا تقليص للسلوك الطبيعي
    const fetchChapterWithFallback = fallbackFn();
    expect(fetchChapterWithFallback).not.toBeNull();

    let clock = 0;
    const tried: (string | null)[] = [];
    await expect(
      fetchChapterWithFallback!({
        copies: copiesOf(4),
        budgetMs: 75_000,
        now: () => clock,
        fetchCopy: async (copy) => {
          tried.push(copy?.key ?? null);
          clock += 500;
        },
        verifyAvailable: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'chapter_unavailable' });

    expect(tried).toHaveLength(4);
  });
});
