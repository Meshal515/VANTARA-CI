/**
 * أفضل خمسة أعمال (§9).
 *
 * الشرط الحاكم في الوثيقة: «لا يجوز أن يكون الترتيب غامضًا أو معتمدًا على
 * خوارزمية اجتماعية معقدة». فكل صفٍّ يرجع معه **سببه**، والاختيار الصريح
 * يسبق أي اشتقاق دائمًا.
 */
import { describe, expect, it } from 'vitest';
import { TOP_WORKS_LIMIT, topWorks } from './top-works.ts';

const chosen = (refs: string[], from = 0) =>
  refs.map((seriesRef, i) => ({ seriesRef, position: from + i, member: 1 }));

describe('what a friend chose', () => {
  it('shows the chosen works in the order they were placed', () => {
    const result = topWorks({ chosen: chosen(['b', 'a', 'c']) });
    expect(result.source).toBe('chosen');
    expect(result.items.map((item) => item.seriesRef)).toEqual(['b', 'a', 'c']);
    expect(result.items.every((item) => item.basis === 'chosen')).toBe(true);
  });

  it('keeps only the first five, so the order decides what shows', () => {
    const result = topWorks({ chosen: chosen(['a', 'b', 'c', 'd', 'e', 'f', 'g']) });
    expect(result.items).toHaveLength(TOP_WORKS_LIMIT);
    expect(result.items.map((item) => item.seriesRef)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('ignores a work that was removed from the collection', () => {
    const rows = [
      { seriesRef: 'a', position: 0, member: 1 },
      { seriesRef: 'gone', position: 1, member: 0 },
      { seriesRef: 'b', position: 2, member: 1 },
    ];
    expect(topWorks({ chosen: rows }).items.map((item) => item.seriesRef)).toEqual(['a', 'b']);
  });

  it('never reorders two works that share a position', () => {
    // الترتيب الثابت شرط: صفوف ترقص في كل مزامنة تُقرأ كعطل
    const rows = [
      { seriesRef: 'zz', position: 3, member: 1 },
      { seriesRef: 'aa', position: 3, member: 1 },
    ];
    expect(topWorks({ chosen: rows }).items.map((item) => item.seriesRef)).toEqual(['aa', 'zz']);
  });
});

describe('when a friend chose nothing yet', () => {
  it('derives from the highest ratings, and says so', () => {
    const result = topWorks({
      chosen: [],
      ratings: [
        { seriesRef: 'low', score: 4 },
        { seriesRef: 'best', score: 10 },
        { seriesRef: 'mid', score: 7 },
      ],
    });

    expect(result.source).toBe('derived');
    expect(result.items.map((item) => item.seriesRef)).toEqual(['best', 'mid', 'low']);
    expect(result.items[0].basis).toBe('rating');
  });

  it('puts a reread above an unrated work, since rereading is the louder vote', () => {
    const result = topWorks({
      chosen: [],
      ratings: [],
      chapterReads: [
        { seriesRef: 'reread', readCount: 3 },
        { seriesRef: 'once', readCount: 1 },
      ],
    });

    expect(result.items[0].seriesRef).toBe('reread');
    expect(result.items[0].basis).toBe('reread');
  });

  it('prefers a rated work over a reread one: a score is the explicit vote', () => {
    const result = topWorks({
      chosen: [],
      ratings: [{ seriesRef: 'rated', score: 6 }],
      chapterReads: [{ seriesRef: 'reread', readCount: 9 }],
    });
    expect(result.items[0].seriesRef).toBe('rated');
  });

  it('breaks a tie by name so the order never flickers', () => {
    const result = topWorks({
      chosen: [],
      ratings: [
        { seriesRef: 'zz', score: 8 },
        { seriesRef: 'aa', score: 8 },
      ],
    });
    expect(result.items.map((item) => item.seriesRef)).toEqual(['aa', 'zz']);
  });

  it('returns nothing rather than inventing a list', () => {
    const result = topWorks({ chosen: [] });
    expect(result.items).toEqual([]);
    expect(result.source).toBe('empty');
  });

  it('does not count a single read as a reread', () => {
    const result = topWorks({ chosen: [], chapterReads: [{ seriesRef: 'once', readCount: 1 }] });
    expect(result.items[0].basis).toBe('reread');
    expect(result.items[0].score).toBe(1);
  });
});
