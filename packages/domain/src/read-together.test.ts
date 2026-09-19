/**
 * اقرأوا سوا (§25) والمنافسة الصامتة (§26).
 *
 * لا جدول جديد ولا مسار: `chapter_reads` يُزامَن لكل الأجهزة أصلًا، وأعلى
 * فصلٍ لكل شخص يُشتقّ منه. §26 تقول صراحة إن المقارنة وحدها تكفي، بلا نقاط
 * ولا مستويات — فما يُخزَّن شيء.
 */
import { describe, expect, it } from 'vitest';
import { readTogether } from './read-together.ts';

const reads = [
  { userId: 'ngm', seriesRef: 'lookism', chapterNumber: 500 },
  { userId: 'mansour', seriesRef: 'lookism', chapterNumber: 497 },
  { userId: 'dahmi', seriesRef: 'lookism', chapterNumber: 312 },
  // فصل أقدم لنفس الشخص: الأعلى هو ما يُعرض
  { userId: 'ngm', seriesRef: 'lookism', chapterNumber: 12 },
  // عمل آخر: لا يدخل هذه اللوحة
  { userId: 'dahmi', seriesRef: 'other', chapterNumber: 900 },
];

describe('the group board for one work', () => {
  it('shows each reader at their furthest chapter, highest first', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'dahmi' });
    expect(board.rows.map((row) => [row.userId, row.chapter])).toEqual([
      ['ngm', 500],
      ['mansour', 497],
      ['dahmi', 312],
    ]);
  });

  it('marks the viewer so the screen can say «أنت»', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'dahmi' });
    expect(board.rows.filter((row) => row.isViewer).map((row) => row.userId)).toEqual(['dahmi']);
  });

  it('ignores another work entirely', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'ngm' });
    expect(board.rows.map((row) => row.userId)).not.toContain('nobody');
    expect(board.rows.every((row) => row.chapter !== 900)).toBe(true);
  });

  it('leaves out someone who has not opened it', () => {
    // صفرٌ مُختلق يقول «بدأه ووقف»، وهذا كذب
    const board = readTogether({
      seriesRef: 'lookism',
      reads: [{ userId: 'ngm', seriesRef: 'lookism', chapterNumber: 5 }],
      viewerId: 'dahmi',
    });
    expect(board.rows.map((row) => row.userId)).toEqual(['ngm']);
  });

  it('skips a read with no chapter number, which cannot be placed', () => {
    const board = readTogether({
      seriesRef: 'lookism',
      reads: [
        { userId: 'ngm', seriesRef: 'lookism', chapterNumber: null },
        { userId: 'mansour', seriesRef: 'lookism', chapterNumber: 3 },
      ],
      viewerId: 'ngm',
    });
    expect(board.rows.map((row) => row.userId)).toEqual(['mansour']);
  });

  it('breaks a tie by name so the board never flickers', () => {
    const board = readTogether({
      seriesRef: 's',
      reads: [
        { userId: 'zz', seriesRef: 's', chapterNumber: 10 },
        { userId: 'aa', seriesRef: 's', chapterNumber: 10 },
      ],
      viewerId: 'aa',
    });
    expect(board.rows.map((row) => row.userId)).toEqual(['aa', 'zz']);
  });
});

describe('the silent competition (§26)', () => {
  it('says how far the leader is ahead of me', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'mansour' });
    expect(board.viewerChapter).toBe(497);
    expect(board.leaderChapter).toBe(500);
    expect(board.behindBy).toBe(3);
  });

  it('reports nothing to chase when I am the leader', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'ngm' });
    expect(board.behindBy).toBe(0);
  });

  it('has no comparison to make when I have not started', () => {
    const board = readTogether({ seriesRef: 'lookism', reads, viewerId: 'someone' });
    expect(board.viewerChapter).toBeNull();
    expect(board.behindBy).toBeNull();
    expect(board.rows).toHaveLength(3);
  });

  it('is empty, not broken, when nobody read it', () => {
    const board = readTogether({ seriesRef: 'nothing', reads, viewerId: 'ngm' });
    expect(board.rows).toEqual([]);
    expect(board.leaderChapter).toBeNull();
    expect(board.behindBy).toBeNull();
  });
});
