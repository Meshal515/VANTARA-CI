import { describe, expect, it } from 'vitest';
import {
  COLLECTION_KINDS,
  MAX_COLLECTION_ITEMS,
  collectionView,
  isCollectionKind,
  mergeWork,
  missingDescriptors,
  nextPosition,
  reorderCollection,
} from './collections.ts';

const row = (over = {}) => ({
  series_ref: 's1',
  kind: 'favorite',
  member: 1,
  position: null,
  updated_at: 100,
  ...over,
});

const work = (over = {}) => ({
  series_ref: 's1',
  title: 'Nano Machine',
  cover_url: 'cover-1',
  source_id: 'src',
  updated_at: 100,
  ...over,
});

describe('collection kinds', () => {
  it('knows the three kinds and nothing else', () => {
    // `top` هي «أفضل 5» (§9): مجموعة مرتَّبة كالمفضلة، لا جدولٌ ثالث
    expect(COLLECTION_KINDS).toEqual(['favorite', 'read_later', 'top']);
    expect(isCollectionKind('favorite')).toBe(true);
    expect(isCollectionKind('read_later')).toBe(true);
    expect(isCollectionKind('top')).toBe(true);
    // القائمة مغلقة: عميل قديم أو حمولة مشوَّهة لا تخلق نوعًا رابعًا
    expect(isCollectionKind('watchlist')).toBe(false);
  });

  it('bounds membership so sync cannot grow without limit', () => {
    expect(MAX_COLLECTION_ITEMS).toBeGreaterThan(0);
  });
});

describe('collectionView', () => {
  it('keeps only the asked kind', () => {
    const rows = [row(), row({ series_ref: 's2', kind: 'read_later' })];
    expect(collectionView({ rows, kind: 'favorite' }).map((i) => i.seriesRef)).toEqual(['s1']);
    expect(collectionView({ rows, kind: 'read_later' }).map((i) => i.seriesRef)).toEqual(['s2']);
  });

  it('drops a tombstoned row without deleting history', () => {
    // الخروج يُكتب `member = 0` ويُزامَن؛ الحذف الصامت يعيد العمل من جهاز آخر
    const rows = [row({ member: 0 }), row({ series_ref: 's2' })];
    expect(collectionView({ rows, kind: 'favorite' }).map((i) => i.seriesRef)).toEqual(['s2']);
  });

  it('treats a row with no member column as a member', () => {
    expect(collectionView({ rows: [row({ member: undefined })], kind: 'favorite' })).toHaveLength(1);
  });

  it('enriches from the work descriptor', () => {
    const view = collectionView({ rows: [row()], works: [work()], kind: 'favorite' });
    expect(view[0]).toMatchObject({
      title: 'Nano Machine',
      coverUrl: 'cover-1',
      needsDescriptor: false,
    });
  });

  it('flags a favourite that has no descriptor at all', () => {
    // هذا هو الواقع قبل B7: `favorite.set` يحمل المعرّف وحده، فلا عنوان ولا غلاف
    // في أي مكان — والشاشة تعرض معرّفًا خامًا.
    const view = collectionView({ rows: [row()], works: [], kind: 'favorite' });
    expect(view[0]).toMatchObject({ title: null, coverUrl: null, needsDescriptor: true });
    expect(missingDescriptors({ rows: [row()], works: [], kind: 'favorite' })).toEqual(['s1']);
  });

  it('orders explicit positions first, ascending', () => {
    const rows = [
      row({ series_ref: 'c', position: 2 }),
      row({ series_ref: 'a', position: 0 }),
      row({ series_ref: 'b', position: 1 }),
    ];
    expect(collectionView({ rows, kind: 'favorite' }).map((i) => i.seriesRef)).toEqual(['a', 'b', 'c']);
  });

  it('puts unpositioned rows after positioned ones, newest first', () => {
    const rows = [
      row({ series_ref: 'old', updated_at: 10 }),
      row({ series_ref: 'pinned', position: 0 }),
      row({ series_ref: 'new', updated_at: 90 }),
    ];
    expect(collectionView({ rows, kind: 'favorite' }).map((i) => i.seriesRef)).toEqual([
      'pinned',
      'new',
      'old',
    ]);
  });

  it('honours a limit', () => {
    const rows = [row({ series_ref: 'a' }), row({ series_ref: 'b' }), row({ series_ref: 'c' })];
    expect(collectionView({ rows, kind: 'favorite', limit: 2 })).toHaveLength(2);
  });

  it('returns nothing for an empty collection', () => {
    expect(collectionView({ rows: [], kind: 'favorite' })).toEqual([]);
    expect(missingDescriptors({ rows: [], kind: 'favorite' })).toEqual([]);
  });
});

describe('nextPosition', () => {
  it('appends after the highest position', () => {
    const rows = [row({ position: 0 }), row({ series_ref: 's2', position: 4 })];
    expect(nextPosition(rows, 'favorite')).toBe(5);
  });

  it('starts at zero with no positioned rows', () => {
    expect(nextPosition([row()], 'favorite')).toBe(0);
    expect(nextPosition([], 'favorite')).toBe(0);
  });

  it('ignores the other kind and tombstones', () => {
    const rows = [row({ kind: 'read_later', position: 9 }), row({ position: 3, member: 0 })];
    expect(nextPosition(rows, 'favorite')).toBe(0);
  });
});

describe('reorderCollection', () => {
  const rows = [
    row({ series_ref: 'a', position: 0 }),
    row({ series_ref: 'b', position: 1 }),
    row({ series_ref: 'c', position: 2 }),
  ];

  it('moves an item and renumbers everything', () => {
    expect(reorderCollection({ rows, kind: 'favorite', seriesRef: 'c', toIndex: 0 })).toEqual([
      { seriesRef: 'c', position: 0 },
      { seriesRef: 'a', position: 1 },
      { seriesRef: 'b', position: 2 },
    ]);
  });

  it('clamps a target beyond the ends', () => {
    expect(
      reorderCollection({ rows, kind: 'favorite', seriesRef: 'a', toIndex: 99 }).at(-1),
    ).toEqual({ seriesRef: 'a', position: 2 });
    expect(
      reorderCollection({ rows, kind: 'favorite', seriesRef: 'c', toIndex: -5 })[0],
    ).toEqual({ seriesRef: 'c', position: 0 });
  });

  it('returns nothing for a work that is not in the collection', () => {
    expect(reorderCollection({ rows, kind: 'favorite', seriesRef: 'zz', toIndex: 0 })).toEqual([]);
  });

  it('leaves the order alone when the target is the current index', () => {
    expect(reorderCollection({ rows, kind: 'favorite', seriesRef: 'b', toIndex: 1 })).toEqual([
      { seriesRef: 'a', position: 0 },
      { seriesRef: 'b', position: 1 },
      { seriesRef: 'c', position: 2 },
    ]);
  });
});

describe('mergeWork', () => {
  it('takes the incoming descriptor when there is none', () => {
    expect(mergeWork(null, work())).toMatchObject({ title: 'Nano Machine' });
  });

  it('lets the newer descriptor win field by field', () => {
    const merged = mergeWork(work(), work({ title: 'ناno جديد', updated_at: 200 }));
    expect(merged.title).toBe('ناno جديد');
    expect(merged.updated_at).toBe(200);
  });

  it('never lets an empty value erase one we already have', () => {
    // مصدر يرجع بلا غلاف لا يجوز أن يمحو غلافًا وصلنا من مصدر آخر
    const merged = mergeWork(work(), work({ cover_url: null, title: '', updated_at: 300 }));
    expect(merged.cover_url).toBe('cover-1');
    expect(merged.title).toBe('Nano Machine');
  });

  it('keeps the older value when the incoming one is stale', () => {
    const merged = mergeWork(work({ updated_at: 500 }), work({ title: 'قديم', updated_at: 10 }));
    expect(merged.title).toBe('Nano Machine');
    expect(merged.updated_at).toBe(500);
  });
});
