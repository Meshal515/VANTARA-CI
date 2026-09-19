import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DOWNLOAD_STATES,
  downloadSummary,
  nextDownloadTargets,
  planEviction,
  totalDownloadBytes,
} from './downloads.ts';

const entry = (over = {}) => ({
  seriesRef: 's1',
  chapterKey: 'c1',
  state: 'ready',
  pages: 20,
  bytes: 1_000,
  savedAt: 10,
  lastReadAt: 10,
  ...over,
});

describe('download states', () => {
  it('names the four states a local file can be in', () => {
    expect(DOWNLOAD_STATES).toEqual(['queued', 'fetching', 'ready', 'failed']);
    expect(DEFAULT_MAX_DOWNLOAD_BYTES).toBeGreaterThan(0);
  });
});

describe('downloadSummary', () => {
  it('rolls chapters up per work', () => {
    const summary = downloadSummary([
      entry({ chapterKey: 'c1' }),
      entry({ chapterKey: 'c2', state: 'failed', bytes: 5 }),
      entry({ seriesRef: 's2', chapterKey: 'c3', lastReadAt: 99 }),
    ]);
    expect(summary.map((row) => row.seriesRef)).toEqual(['s2', 's1']);
    const first = summary.find((row) => row.seriesRef === 's1');
    expect(first).toMatchObject({ chapters: 2, ready: 1, failed: 1, bytes: 1_005 });
  });

  it('orders by last read, not by when it was downloaded', () => {
    // ما يقرأه المستخدم الآن في الأعلى، لا ما نزّله أولًا
    const summary = downloadSummary([
      entry({ seriesRef: 'old', savedAt: 1, lastReadAt: 1 }),
      entry({ seriesRef: 'reading', savedAt: 999, lastReadAt: 500 }),
    ]);
    expect(summary[0]?.seriesRef).toBe('reading');
  });

  it('treats a missing or corrupt size as zero', () => {
    expect(totalDownloadBytes([entry({ bytes: null }), entry({ bytes: -5 })])).toBe(0);
  });

  it('summarises nothing without throwing', () => {
    expect(downloadSummary([])).toEqual([]);
  });
});

describe('planEviction', () => {
  it('does nothing while under budget', () => {
    const plan = planEviction({ entries: [entry()], maxBytes: 10_000 });
    expect(plan.evict).toEqual([]);
    expect(plan.stillOverBudget).toBe(false);
  });

  it('drops failed downloads first', () => {
    // بايتات محجوزة لتنزيل لم يكمل ليست محتوى
    const plan = planEviction({
      entries: [
        entry({ chapterKey: 'ready-old', lastReadAt: 1 }),
        entry({ chapterKey: 'failed-new', state: 'failed', lastReadAt: 900 }),
      ],
      maxBytes: 1_000,
    });
    expect(plan.evict.map((e) => e.chapterKey)).toEqual(['failed-new']);
  });

  it('then drops the least recently read', () => {
    const plan = planEviction({
      entries: [
        entry({ chapterKey: 'a', lastReadAt: 300 }),
        entry({ chapterKey: 'b', lastReadAt: 100 }),
        entry({ chapterKey: 'c', lastReadAt: 200 }),
      ],
      maxBytes: 1_000,
    });
    expect(plan.evict.map((e) => e.chapterKey)).toEqual(['b', 'c']);
    expect(plan.bytesAfter).toBe(1_000);
  });

  it('never evicts the chapter being read', () => {
    // الإخلاء أثناء القراءة يمسح صفحات أمام القارئ
    const plan = planEviction({
      entries: [entry({ chapterKey: 'reading', lastReadAt: 1 }), entry({ chapterKey: 'other' })],
      maxBytes: 500,
      keepChapterKeys: ['reading'],
    });
    expect(plan.evict.map((e) => e.chapterKey)).toEqual(['other']);
    expect(plan.stillOverBudget).toBe(true);
  });

  it('never evicts a download in flight', () => {
    const plan = planEviction({
      entries: [entry({ chapterKey: 'mid', state: 'fetching' })],
      maxBytes: 0,
    });
    expect(plan.evict).toEqual([]);
    expect(plan.stillOverBudget).toBe(true);
  });

  it('reports honestly when nothing may be freed', () => {
    const plan = planEviction({ entries: [entry({ state: 'fetching' })], maxBytes: 1 });
    expect(plan.stillOverBudget).toBe(true);
  });

  it('prefers a never-read file over one read long ago', () => {
    const plan = planEviction({
      entries: [entry({ chapterKey: 'read-once', lastReadAt: 5 }), entry({ chapterKey: 'never', lastReadAt: 0 })],
      maxBytes: 1_000,
    });
    expect(plan.evict.map((e) => e.chapterKey)).toEqual(['never']);
  });
});

describe('nextDownloadTargets', () => {
  const wanted = [
    { chapterKey: 'c10', seriesRef: 's1', number: 10 },
    { chapterKey: 'c11', seriesRef: 's1', number: 11 },
    { chapterKey: 'c12', seriesRef: 's1', number: 12 },
    { chapterKey: 'c13', seriesRef: 's1', number: 13 },
  ];

  it('takes the chapters right after where the reader is', () => {
    // القارئ يريد الفصل الذي يليه، لا أحدث فصل صدر
    const targets = nextDownloadTargets({ have: [], wanted, after: 10, limit: 2 });
    expect(targets.map((t) => t.chapterKey)).toEqual(['c11', 'c12']);
  });

  it('skips what is already on the device', () => {
    const targets = nextDownloadTargets({
      have: [entry({ chapterKey: 'c11' })],
      wanted,
      after: 10,
      limit: 2,
    });
    expect(targets.map((t) => t.chapterKey)).toEqual(['c12', 'c13']);
  });

  it('retries a failed download', () => {
    const targets = nextDownloadTargets({
      have: [entry({ chapterKey: 'c11', state: 'failed' })],
      wanted,
      after: 10,
      limit: 1,
    });
    expect(targets.map((t) => t.chapterKey)).toEqual(['c11']);
  });

  it('returns nothing at the end of the series', () => {
    expect(nextDownloadTargets({ have: [], wanted, after: 13 })).toEqual([]);
  });

  it('respects a zero limit', () => {
    expect(nextDownloadTargets({ have: [], wanted, after: 10, limit: 0 })).toEqual([]);
  });
});
