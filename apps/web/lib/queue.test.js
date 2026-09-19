import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  OP_CLASS,
  RETRY_MAX_MS,
  STUCK_AFTER_MS,
  classifyFailure,
  classifyOp,
  compactQueue,
  nextAttemptDelay,
  shouldQuarantine,
  stateKeyOf,
  syncHealth,
  trimQueue,
} from './queue.js';

const op = (kind, payload = {}, opId = `${kind}-${JSON.stringify(payload)}`) => ({
  opId,
  kind,
  payload,
});

describe('classifyOp', () => {
  it('separates state replacement from cumulative credit', () => {
    expect(classifyOp('progress.set')).toBe(OP_CLASS.STATE);
    expect(classifyOp('favorite.set')).toBe(OP_CLASS.STATE);
    expect(classifyOp('chapter.complete')).toBe(OP_CLASS.CUMULATIVE);
    expect(classifyOp('usage.add')).toBe(OP_CLASS.CUMULATIVE);
    expect(classifyOp('comment.add')).toBe(OP_CLASS.EVENT);
  });

  it('treats an unknown kind as cumulative so it is never dropped', () => {
    expect(classifyOp('something.new')).toBe(OP_CLASS.CUMULATIVE);
    expect(stateKeyOf(op('something.new'))).toBeNull();
  });
});

describe('compactQueue', () => {
  it('keeps one op per target and leaves everything else alone', () => {
    const queue = [
      op('favorite.set', { seriesRef: 'a', member: true }),
      op('usage.add', { activeMs: 1000 }),
      op('favorite.set', { seriesRef: 'a', member: false }),
      op('favorite.set', { seriesRef: 'b', member: true }),
    ];
    const out = compactQueue(queue);
    expect(out).toHaveLength(3);
    expect(out.filter((entry) => entry.kind === 'favorite.set')).toHaveLength(2);
    expect(out.find((entry) => entry.payload.seriesRef === 'a').payload.member).toBe(false);
  });

  it('never drops a cumulative op even when identical', () => {
    // فصلان مقروءان بنفس الحمولة عمليتان مختلفتان فعلًا: +1 و+1
    const queue = [
      op('chapter.complete', { chapterKey: 'c1' }, 'op-1'),
      op('chapter.complete', { chapterKey: 'c1' }, 'op-2'),
    ];
    expect(compactQueue(queue)).toHaveLength(2);
  });

  it('never drops an event', () => {
    const queue = [
      op('comment.add', { seriesRef: 's', body: 'أول' }, 'op-1'),
      op('comment.add', { seriesRef: 's', body: 'ثانٍ' }, 'op-2'),
    ];
    expect(compactQueue(queue)).toHaveLength(2);
  });

  it('merges progress by max instead of keeping the last write', () => {
    // القارئ وصل 30 ثم رجع إلى 12. الخادم يدمج بـMAX، فلو أرسلنا 12 وحدها
    // لما عرف الخادم بالـ30 أبدًا — وهذا تقدم حقيقي يُفقد.
    const queue = [
      op('progress.set', { chapterKey: 'c1', page: 30, ratio: 0.9 }, 'op-1'),
      op('progress.set', { chapterKey: 'c1', page: 12, ratio: 0.3 }, 'op-2'),
    ];
    const out = compactQueue(queue);
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({ page: 30, ratio: 0.9 });
  });

  it('keeps progress of different chapters apart', () => {
    const queue = [
      op('progress.set', { chapterKey: 'c1', page: 5, ratio: 0.1 }),
      op('progress.set', { chapterKey: 'c2', page: 7, ratio: 0.2 }),
    ];
    expect(compactQueue(queue)).toHaveLength(2);
  });

  it('keeps two profile patches that touch different fields', () => {
    const queue = [
      op('profile.patch', { fields: { bio: 'نبذة' } }, 'op-1'),
      op('profile.patch', { fields: { avatarKey: 'k' } }, 'op-2'),
    ];
    expect(compactQueue(queue)).toHaveLength(2);
  });

  it('compacts two profile patches to the same field', () => {
    const queue = [
      op('profile.patch', { fields: { bio: 'أولى' } }, 'op-1'),
      op('profile.patch', { fields: { bio: 'أخيرة' } }, 'op-2'),
    ];
    const out = compactQueue(queue);
    expect(out).toHaveLength(1);
    expect(out[0].payload.fields.bio).toBe('أخيرة');
  });

  it('places the surviving op at the position of its last occurrence', () => {
    const queue = [
      op('favorite.set', { seriesRef: 'a', member: true }, 'op-1'),
      op('chapter.complete', { chapterKey: 'c1' }, 'op-2'),
      op('favorite.set', { seriesRef: 'a', member: false }, 'op-3'),
    ];
    expect(compactQueue(queue).map((entry) => entry.opId)).toEqual(['op-2', 'op-3']);
  });

  it('collapses an add/remove pair of the same work to the final intent', () => {
    const queue = [
      op('library.add', { seriesRef: 'x' }, 'op-1'),
      op('library.remove', { seriesRef: 'x' }, 'op-2'),
    ];
    const out = compactQueue(queue);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('library.remove');
  });

  it('leaves an already minimal queue untouched', () => {
    const queue = [op('usage.add', { activeMs: 10 }), op('comment.add', { body: 'x' })];
    expect(compactQueue(queue)).toEqual(queue);
  });
});

describe('trimQueue', () => {
  it('compacts before dropping anything', () => {
    const queue = [
      op('progress.set', { chapterKey: 'c1', page: 1, ratio: 0.1 }, 'op-1'),
      op('progress.set', { chapterKey: 'c1', page: 2, ratio: 0.2 }, 'op-2'),
      op('usage.add', { activeMs: 5 }, 'op-3'),
    ];
    const out = trimQueue(queue, 2);
    expect(out.dropped).toBe(0);
    expect(out.ops).toHaveLength(2);
  });

  it('drops the oldest state op and keeps every cumulative one', () => {
    // هذا هو العيب الذي كان: الطابور الممتلئ يُسقط الأقدم، والأقدم قراءة فصل
    const queue = [
      op('chapter.complete', { chapterKey: 'c1' }, 'read-1'),
      op('usage.add', { activeMs: 60_000 }, 'usage-1'),
      op('favorite.set', { seriesRef: 'a', member: true }, 'fav-1'),
      op('rating.set', { seriesRef: 'b', score: 9 }, 'rate-1'),
    ];
    const out = trimQueue(queue, 3);
    expect(out.dropped).toBe(1);
    expect(out.ops.map((entry) => entry.opId)).toEqual(['read-1', 'usage-1', 'rate-1']);
    expect(out.overflowing).toBe(false);
  });

  it('refuses to drop a cumulative op and reports the overflow instead', () => {
    const queue = [
      op('chapter.complete', { chapterKey: 'c1' }, 'read-1'),
      op('chapter.complete', { chapterKey: 'c2' }, 'read-2'),
      op('usage.add', { activeMs: 1 }, 'usage-1'),
    ];
    const out = trimQueue(queue, 2);
    expect(out.dropped).toBe(0);
    expect(out.ops).toHaveLength(3);
    expect(out.overflowing).toBe(true);
  });

  it('drops only as many state ops as the excess requires', () => {
    const queue = [
      op('favorite.set', { seriesRef: 'a' }, 'fav-a'),
      op('favorite.set', { seriesRef: 'b' }, 'fav-b'),
      op('favorite.set', { seriesRef: 'c' }, 'fav-c'),
      op('chapter.complete', { chapterKey: 'c1' }, 'read-1'),
    ];
    const out = trimQueue(queue, 3);
    expect(out.dropped).toBe(1);
    expect(out.ops.map((entry) => entry.opId)).toEqual(['fav-b', 'fav-c', 'read-1']);
  });
});

describe('classifyFailure', () => {
  it('calls a rejected op permanent and a server fault retriable', () => {
    expect(classifyFailure(400)).toBe('permanent');
    expect(classifyFailure(413)).toBe('permanent');
    expect(classifyFailure(404)).toBe('permanent');
    expect(classifyFailure(500)).toBe('retry');
    expect(classifyFailure(502)).toBe('retry');
    expect(classifyFailure(0)).toBe('retry');
  });

  it('keeps retrying a timeout and a rate limit', () => {
    expect(classifyFailure(408)).toBe('retry');
    expect(classifyFailure(429)).toBe('retry');
  });

  it('separates an expired session from a broken op', () => {
    // الجلسة ليست عطل عملية: العميل يعيد الدخول ولا يعزل كتاباته
    expect(classifyFailure(401)).toBe('auth');
    expect(classifyFailure(403)).toBe('auth');
  });
});

describe('nextAttemptDelay', () => {
  it('grows exponentially and stays under the cap', () => {
    const noJitter = () => 0.5;
    expect(nextAttemptDelay(1, noJitter)).toBe(5_000);
    expect(nextAttemptDelay(2, noJitter)).toBe(10_000);
    expect(nextAttemptDelay(3, noJitter)).toBe(20_000);
    expect(nextAttemptDelay(30, noJitter)).toBe(RETRY_MAX_MS);
  });

  it('spreads three devices that come back together', () => {
    const low = nextAttemptDelay(4, () => 0);
    const high = nextAttemptDelay(4, () => 1);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(1_000);
  });
});

describe('shouldQuarantine', () => {
  it('quarantines a permanently rejected op at once', () => {
    expect(shouldQuarantine({ attempts: 1, status: 400 })).toBe(true);
  });

  it('keeps retrying a server fault until the attempt ceiling', () => {
    expect(shouldQuarantine({ attempts: 1, status: 500 })).toBe(false);
    expect(shouldQuarantine({ attempts: MAX_ATTEMPTS - 1, status: 500 })).toBe(false);
    expect(shouldQuarantine({ attempts: MAX_ATTEMPTS, status: 500 })).toBe(true);
  });
});

describe('syncHealth', () => {
  it('reports ok with an empty queue', () => {
    expect(syncHealth({ pending: 0 }).state).toBe('ok');
  });

  it('never says synced while a read backlog is still pending', () => {
    // `pending` طابور الكتابة وحده. والسحب يخرج عند سقف الجولات وقد بقي
    // `more: true`، فكان الجهاز يقول «مُزامَن» وهو خلف بآلاف الصفوف.
    const health = syncHealth({ pending: 0, backlog: true });
    expect(health.state).toBe('syncing');
    expect(health.state).not.toBe('ok');
  });

  it('says synced once the backlog is drained', () => {
    expect(syncHealth({ pending: 0, backlog: false }).state).toBe('ok');
  });

  it('reports syncing while writes are in flight', () => {
    expect(syncHealth({ pending: 3, lastSuccessAt: Date.now() }).state).toBe('syncing');
  });

  it('reports offline and still counts the pending writes', () => {
    const health = syncHealth({ pending: 2, online: false });
    expect(health.state).toBe('offline');
    expect(health.message).toContain('2');
  });

  it('reports stuck when nothing has landed for a long time', () => {
    const now = Date.now();
    const health = syncHealth({ pending: 1, lastSuccessAt: now - STUCK_AFTER_MS - 1, now });
    expect(health.state).toBe('stuck');
  });

  it('puts non-durable storage above everything else', () => {
    // الكتابة التي لا تُحفظ محليًا تضيع عند إغلاق التطبيق: أخطر من كل ما سبق
    const health = syncHealth({ pending: 5, quarantined: 2, online: false, durable: false });
    expect(health.state).toBe('degraded');
  });

  it('surfaces a quarantined op instead of pretending to sync', () => {
    expect(syncHealth({ pending: 4, quarantined: 1 }).state).toBe('blocked');
  });

  it('surfaces an overflowing queue', () => {
    expect(syncHealth({ pending: 600, overflowing: true }).state).toBe('blocked');
  });

  it('does not call a fresh install stuck', () => {
    // لا نجاح سابق ولا كتابات: لا شيء عالق
    expect(syncHealth({ pending: 0, lastSuccessAt: 0 }).state).toBe('ok');
    expect(syncHealth({ pending: 1, lastSuccessAt: 0 }).state).toBe('syncing');
  });
});
