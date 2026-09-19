import { describe, expect, it } from 'vitest';
import {
  DATA_OWNERSHIP,
  OWNERSHIP_STORES,
  assertSingleOwner,
  mirrorsOf,
  ownerOf,
  ownerOfTable,
  reconcileProgress,
  retiredTables,
} from './ownership.ts';

describe('ownership matrix', () => {
  it('holds a single owner for every data domain', () => {
    expect(() => assertSingleOwner()).not.toThrow();
    expect(DATA_OWNERSHIP.length).toBeGreaterThan(0);
  });

  it('rejects a domain listed under two owners', () => {
    expect(() =>
      assertSingleOwner([
        {
          key: 'reading.progress',
          owner: 'UCHIYOMI',
          mirrors: [],
          tables: {},
          retired: {},
          why: '',
        },
        {
          key: 'reading.progress',
          owner: 'D1',
          mirrors: [],
          tables: {},
          retired: {},
          why: '',
        },
      ]),
    ).toThrow(/reading\.progress/);
  });

  it('rejects a store that is both owner and mirror of the same domain', () => {
    expect(() =>
      assertSingleOwner([
        {
          key: 'reading.progress',
          owner: 'D1',
          mirrors: ['D1'],
          tables: {},
          retired: {},
          why: '',
        },
      ]),
    ).toThrow(/mirror/i);
  });

  it('rejects the same physical table appearing in two domains', () => {
    expect(() =>
      assertSingleOwner([
        {
          key: 'reading.progress',
          owner: 'D1',
          mirrors: [],
          tables: { D1: ['progress'] },
          retired: {},
          why: '',
        },
        {
          key: 'stats.reads',
          owner: 'D1',
          mirrors: [],
          tables: { D1: ['progress'] },
          retired: {},
          why: '',
        },
      ]),
    ).toThrow(/progress/);
  });

  it('rejects a table that is active and retired at once', () => {
    expect(() =>
      assertSingleOwner([
        {
          key: 'social.presence',
          owner: 'D1',
          mirrors: [],
          tables: { D1: ['presence'] },
          retired: { D1: ['presence'] },
          why: '',
        },
      ]),
    ).toThrow(/presence/);
  });

  it('names one owner for each data domain the product actually has', () => {
    expect(ownerOf('reading.progress')).toBe('UCHIYOMI');
    expect(ownerOf('library.membership')).toBe('UCHIYOMI');
    expect(ownerOf('social.presence')).toBe('D1');
    expect(ownerOf('social.comments')).toBe('D1');
    expect(ownerOf('social.recommendations')).toBe('D1');
    expect(ownerOf('stats.reading')).toBe('D1');
    expect(ownerOf('identity.session')).toBe('IDENTITY');
    expect(ownerOf('device.downloads')).toBe('DEVICE');
  });

  it('throws on an unknown domain instead of guessing an owner', () => {
    expect(() => ownerOf('does.not.exist')).toThrow(/does\.not\.exist/);
  });

  it('allows D1 to mirror reading progress but never to own it', () => {
    expect(mirrorsOf('reading.progress')).toContain('D1');
    expect(ownerOf('reading.progress')).not.toBe('D1');
  });

  it('maps a physical table back to the domain that owns it', () => {
    expect(ownerOfTable('D1', 'chapter_reads')?.key).toBe('stats.reading');
    expect(ownerOfTable('D1', 'progress')?.key).toBe('reading.progress');
    expect(ownerOfTable('POSTGRES', 'vantara_reports')?.key).toBe('ops.reports');
    expect(ownerOfTable('POSTGRES', 'vantara_comments')).toBeNull();
  });

  it('assigns B8 social receipt tables to the existing D1 social domains', () => {
    expect(ownerOfTable('D1', 'recommendation_recipients')).toEqual({
      key: 'social.recommendations',
      owner: 'D1',
    });
    expect(ownerOfTable('D1', 'activity_receipts')).toEqual({
      key: 'social.activity',
      owner: 'D1',
    });
  });

  it('lists the retired Postgres social tables so nothing writes them again', () => {
    const retired = retiredTables('POSTGRES');
    expect(retired).toEqual(
      expect.arrayContaining([
        'vantara_profiles',
        'vantara_presence',
        'vantara_reading_sessions',
        'vantara_activity_events',
        'vantara_comments',
        'vantara_comment_reactions',
        'vantara_recommendations',
        'vantara_user_gates',
      ]),
    );
  });

  it('covers every store it declares', () => {
    for (const store of OWNERSHIP_STORES) {
      const owned = DATA_OWNERSHIP.filter((spec) => spec.owner === store);
      expect(owned.length, `no domain owned by ${store}`).toBeGreaterThan(0);
    }
  });
});

describe('reconcileProgress', () => {
  it('pushes the mirror to the owner when the owner never received it', () => {
    const result = reconcileProgress({
      owner: null,
      mirror: { page: 30, ratio: 0.8, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.8 });
    expect(result.action).toEqual({ kind: 'push-to-owner', page: 30, ratio: 0.8 });
  });

  it('pushes when the unconfirmed mirror is ahead of the owner', () => {
    const result = reconcileProgress({
      owner: { page: 12, ratio: 0.3 },
      mirror: { page: 30, ratio: 0.8, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.8 });
    expect(result.action).toEqual({ kind: 'push-to-owner', page: 30, ratio: 0.8 });
  });

  it('never rewinds the owner from a stale mirror', () => {
    const result = reconcileProgress({
      owner: { page: 30, ratio: 0.8 },
      mirror: { page: 12, ratio: 0.3, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.8 });
    expect(result.action).toEqual({ kind: 'correct-mirror', page: 30, ratio: 0.8 });
  });

  it('lets the owner win over a confirmed mirror that is ahead', () => {
    // الإقرار يعني أن المالك قبل هذه القيمة سابقًا. إن صار أقل الآن فذلك قرار
    // عند المالك (إعادة تعيين أو حذف)، والمرآة تتبعه ولا تقاومه.
    const result = reconcileProgress({
      owner: { page: 4, ratio: 0.1 },
      mirror: { page: 30, ratio: 0.8, confirmed: true },
    });
    expect(result.effective).toEqual({ page: 4, ratio: 0.1 });
    expect(result.action).toEqual({ kind: 'correct-mirror', page: 4, ratio: 0.1 });
  });

  it('does nothing when both sides already agree', () => {
    const result = reconcileProgress({
      owner: { page: 30, ratio: 0.8 },
      mirror: { page: 30, ratio: 0.8, confirmed: true },
    });
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('confirms a mirror the owner already matches even if it was never acknowledged', () => {
    const result = reconcileProgress({
      owner: { page: 30, ratio: 0.8 },
      mirror: { page: 30, ratio: 0.8, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.8 });
    expect(result.action).toEqual({ kind: 'confirm-mirror', page: 30, ratio: 0.8 });
  });

  it('treats a missing mirror as nothing to reconcile', () => {
    const result = reconcileProgress({ owner: { page: 7, ratio: 0.2 }, mirror: null });
    expect(result.effective).toEqual({ page: 7, ratio: 0.2 });
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('reports zero progress when neither side has any', () => {
    const result = reconcileProgress({ owner: null, mirror: null });
    expect(result.effective).toEqual({ page: 0, ratio: 0 });
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('ignores a mirror that carries nothing to push', () => {
    const result = reconcileProgress({
      owner: null,
      mirror: { page: 0, ratio: 0, confirmed: false },
    });
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('keeps the higher ratio when pages tie', () => {
    // نفس الصفحة ونسبة أعلى: ويبتون طويل، الصفحة الواحدة نصفها غير مقروء
    const result = reconcileProgress({
      owner: { page: 5, ratio: 0.2 },
      mirror: { page: 5, ratio: 0.95, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 5, ratio: 0.95 });
    expect(result.action).toEqual({ kind: 'push-to-owner', page: 5, ratio: 0.95 });
  });

  it('compares only the page when the owner does not keep a ratio', () => {
    // المالك الحقيقي (Uchiyomi) يحفظ الصفحة و`completed` ولا يعرف نسبة داخلها.
    // مقارنة النسبة بما لا يملكه كانت ستدفع نفس القيمة عند كل إقلاع إلى الأبد.
    const result = reconcileProgress({
      owner: { page: 30 },
      mirror: { page: 30, ratio: 0.95, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.95 });
    expect(result.action).toEqual({ kind: 'confirm-mirror', page: 30, ratio: 0.95 });
  });

  it('still pushes a page the ratio-less owner has not reached', () => {
    const result = reconcileProgress({
      owner: { page: 30 },
      mirror: { page: 31, ratio: 0.2, confirmed: false },
    });
    expect(result.action).toEqual({ kind: 'push-to-owner', page: 31, ratio: 0.2 });
  });

  it('keeps the mirror ratio when a ratio-less owner confirms the same page', () => {
    const result = reconcileProgress({
      owner: { page: 30, ratio: null },
      mirror: { page: 30, ratio: 0.95, confirmed: true },
    });
    expect(result.effective).toEqual({ page: 30, ratio: 0.95 });
    expect(result.action).toEqual({ kind: 'none' });
  });

  it('pulls the mirror back when a ratio-less owner is behind and confirmed', () => {
    const result = reconcileProgress({
      owner: { page: 4 },
      mirror: { page: 30, ratio: 0.8, confirmed: true },
    });
    expect(result.effective).toEqual({ page: 4, ratio: 0.8 });
    expect(result.action).toEqual({ kind: 'correct-mirror', page: 4, ratio: 0.8 });
  });

  it('clamps a corrupt mirror instead of pushing it to the owner', () => {
    const result = reconcileProgress({
      owner: { page: 3, ratio: 0.1 },
      mirror: { page: -8, ratio: 4, confirmed: false },
    });
    expect(result.effective).toEqual({ page: 3, ratio: 1 });
    expect(result.action.kind).toBe('push-to-owner');
  });
});
