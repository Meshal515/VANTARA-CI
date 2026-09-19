/**
 * ترجمة العمليات إلى SQL، بـD1 مُسجِّلة.
 *
 * دوال المجال مُختبرة في `@vantara/domain`، لكن ما يصل قاعدة المستخدمين هو
 * **هذه** الجُمل: عمودٌ ناقص، أو حرسٌ في `WHERE` مكتوب بالعكس، أو إشعارٌ لا
 * يُنشأ لأحد — كلها تمرّ من اختبارات الدوال النقية بلا أن تُلمس. الـD1 هنا
 * تسجّل الجملة وقيَمها بلا تنفيذ: هذا يثبت العقد لا السلوك النهائي، والسلوك
 * النهائي يبقى على `verify.mjs` أمام D1 حقيقية.
 */
import { describe, expect, it } from 'vitest';
import { statementsFor, type OpContext } from './index.ts';
import type { D1PreparedStatement, Env } from './types.ts';

interface Recorded {
  sql: string;
  values: unknown[];
}

/** D1 مُسجِّلة: تحفظ كل جملة وقيَمها ولا تنفّذ شيئًا. */
function recorder(): { env: Env; statements: Recorded[] } {
  const statements: Recorded[] = [];
  const prepare = (sql: string): D1PreparedStatement => {
    const entry: Recorded = { sql, values: [] };
    statements.push(entry);
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        entry.values = values;
        return statement;
      },
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: {} }),
    };
    return statement;
  };

  const env = {
    DB: {
      prepare,
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
    },
    VANTARA_SESSION_SECRET: 'test-secret',
  } as unknown as Env;

  return { env, statements };
}

const NOW = 1_700_000_000_000;
const REV = 42;
const ACCOUNTS: OpContext = { accounts: ['dahmi', 'mansour', 'ngm'] };

function translate(
  kind: string,
  payload: Record<string, unknown>,
  { userId = 'dahmi', opId = 'op-1', ctx = ACCOUNTS } = {},
): Recorded[] {
  const { env, statements } = recorder();
  const built = statementsFor({ opId, kind, payload }, userId, REV, NOW, env, ctx);
  // الجُمل التي بُنيت فعلًا، لا كل ما لمسه `prepare`
  return built === null ? [] : statements.slice(0, built.length);
}

describe('recommendation.send', () => {
  it('notifies the one named recipient', () => {
    const out = translate('recommendation.send', { seriesRef: 's1', toId: 'ngm', message: 'اقرأه' });
    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification).toBeDefined();
    expect(notification?.values).toContain('ngm');
    expect(out.filter((entry) => entry.sql.includes('INSERT INTO notifications'))).toHaveLength(1);
  });

  it('notifies everyone but the sender when it is for all', () => {
    // العيب: `toId` فارغ كان لا يُنشئ إشعارًا لأحد. التوصية تُسجَّل ولا يعرف بها أحد.
    const out = translate('recommendation.send', { seriesRef: 's1', message: 'للجميع' });
    const notifications = out.filter((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notifications).toHaveLength(2);
    const recipients = notifications.map((entry) => entry.values[1]);
    expect(recipients).toEqual(['mansour', 'ngm']);
    expect(recipients).not.toContain('dahmi');
  });

  it('derives a stable notification id per recipient so a retry cannot duplicate', () => {
    const first = translate('recommendation.send', { seriesRef: 's1' }, { opId: 'op-9' });
    const again = translate('recommendation.send', { seriesRef: 's1' }, { opId: 'op-9' });
    const ids = (rows: Recorded[]) =>
      rows.filter((entry) => entry.sql.includes('INSERT INTO notifications')).map((entry) => entry.values[0]);
    expect(ids(first)).toEqual(['op-9:mansour', 'op-9:ngm']);
    expect(ids(again)).toEqual(ids(first));
  });

  it('writes a fresh notification as unread and unseen', () => {
    const out = translate('recommendation.send', { seriesRef: 's1', toId: 'ngm' });
    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification?.sql).toContain('read, seen');
    expect(notification?.sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, \?, 0, 0, \?, \?\)/);
    expect(notification?.sql).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('carries a deep link to the work itself', () => {
    const out = translate('recommendation.send', { seriesRef: 'a/b c', toId: 'ngm' });
    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification?.values).toContain('vantara://series/a%2Fb%20c');
  });

  it('refuses an op with no work', () => {
    expect(translate('recommendation.send', { toId: 'ngm' })).toEqual([]);
  });
});

describe('notification state ops', () => {
  it('marks seen without touching read', () => {
    const [statement] = translate('notification.seen', { id: 'n1' });
    expect(statement?.sql).toContain('SET seen = 1');
    expect(statement?.sql).not.toContain('read = 1');
    // الحرس: لا يكتب فوق صفّ عُرض سابقًا فيرفع rev بلا داعٍ
    expect(statement?.sql).toContain('seen = 0');
    expect(statement?.values).toEqual([REV, 'n1', 'dahmi']);
  });

  it('marks read as seen too', () => {
    const [statement] = translate('notification.read', { id: 'n1' });
    expect(statement?.sql).toContain('read = 1, seen = 1');
  });

  it('scopes both to the owner of the notification', () => {
    for (const kind of ['notification.read', 'notification.seen']) {
      const [statement] = translate(kind, { id: 'n1' }, { userId: 'ngm' });
      expect(statement?.sql).toContain('user_id = ?');
      expect(statement?.values).toContain('ngm');
    }
  });

  it('refuses an op with no id', () => {
    expect(translate('notification.seen', {})).toEqual([]);
    expect(translate('notification.read', {})).toEqual([]);
  });
});

describe('progress ops', () => {
  it('writes the mirror as not yet confirmed by the owner', () => {
    const [statement] = translate('progress.set', {
      chapterKey: 'c1',
      seriesRef: 's1',
      page: 30,
      ratio: 0.9,
    });
    expect(statement?.sql).toContain('owner_synced');
    expect(statement?.sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, \?, 0\)/);
    // الدمج بـMAX: جهاز قديم لا يُرجع التقدم للخلف
    expect(statement?.sql).toContain('MAX(progress.page, excluded.page)');
  });

  it('clears the confirmation only when the merged value actually moved', () => {
    const [statement] = translate('progress.set', { chapterKey: 'c1', seriesRef: 's1', page: 1, ratio: 0 });
    expect(statement?.sql).toContain('THEN progress.owner_synced ELSE 0 END');
  });

  it('guards the confirmation against a row that moved on', () => {
    const [statement] = translate('progress.confirm', { chapterKey: 'c1', page: 12 });
    expect(statement?.sql).toContain('owner_synced = 1');
    expect(statement?.sql).toContain('page <= ?');
    expect(statement?.values).toEqual([REV, 'dahmi', 'c1', 12]);
  });

  it('refuses a confirmation with no page', () => {
    expect(translate('progress.confirm', { chapterKey: 'c1' })).toEqual([]);
  });
});

describe('cumulative ops', () => {
  it('guards a chapter read against double counting inside the claim batch', () => {
    const [statement] = translate('chapter.complete', {
      chapterKey: 'c1',
      seriesRef: 's1',
      chapterNumber: 1,
      ratio: 1,
      activeMs: 9_000,
    });
    expect(statement?.sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM applied_ops WHERE op_id = ?)');
    expect(statement?.sql).toContain('read_count = chapter_reads.read_count + 1');
  });

  it('refuses a one-second open as a read', () => {
    expect(
      translate('chapter.complete', { chapterKey: 'c1', seriesRef: 's1', ratio: 1, activeMs: 400 }),
    ).toEqual([]);
  });

  it('adds usage time and guards it the same way', () => {
    const [statement] = translate('usage.add', { activeMs: 60_000, day: '2026-09-18' });
    expect(statement?.sql).toContain('active_ms = usage_daily.active_ms + excluded.active_ms');
    expect(statement?.sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM applied_ops WHERE op_id = ?)');
  });
});

describe('collections', () => {
  it('records the work descriptor beside the membership', () => {
    // العيب: `favorite.set` كان يحمل المعرّف وحده، فلا عنوان ولا غلاف في أي
    // مكان لعمل يُضاف للمفضلة من صفحته — والشاشة تعرض معرّفًا خامًا
    const out = translate('favorite.set', {
      seriesRef: 's1',
      seriesTitle: 'Nano Machine',
      coverUrl: 'cover-1',
      sourceId: 'src',
    });
    const work = out.find((entry) => entry.sql.includes('INSERT INTO works'));
    expect(work).toBeDefined();
    expect(work?.values).toEqual(['s1', 'Nano Machine', 'cover-1', 'src', NOW, REV]);
    expect(out.some((entry) => entry.sql.includes('INSERT INTO collections'))).toBe(true);
  });

  it('writes no descriptor when the op carries none', () => {
    const out = translate('readLater.set', { seriesRef: 's1' });
    expect(out.some((entry) => entry.sql.includes('INSERT INTO works'))).toBe(false);
    expect(out).toHaveLength(1);
  });

  it('never lets an empty descriptor erase what we already know', () => {
    const out = translate('favorite.set', { seriesRef: 's1', seriesTitle: 'عنوان' });
    const work = out.find((entry) => entry.sql.includes('INSERT INTO works'));
    expect(work?.sql).toContain('COALESCE(excluded.title, works.title)');
    expect(work?.sql).toContain('COALESCE(excluded.cover_url, works.cover_url)');
  });

  it('keeps the chosen position when a work is re-added', () => {
    const out = translate('favorite.set', { seriesRef: 's1' });
    expect(out[0]?.sql).toContain('COALESCE(excluded.position, collections.position)');
  });

  it('separates the two collection kinds', () => {
    const favorite = translate('favorite.set', { seriesRef: 's1' });
    const later = translate('readLater.set', { seriesRef: 's1' });
    expect(favorite[0]?.values).toContain('favorite');
    expect(later[0]?.values).toContain('read_later');
  });

  it('reorders a whole list in one op', () => {
    // ترتيب كامل لا حركة عنصر: حركتان من جهازين تتشابكان
    const out = translate('collection.reorder', {
      kind: 'favorite',
      order: ['c', 'a', 'b'],
    });
    expect(out).toHaveLength(3);
    expect(out.map((entry) => entry.values)).toEqual([
      [0, NOW, REV, 'dahmi', 'favorite', 'c'],
      [1, NOW, REV, 'dahmi', 'favorite', 'a'],
      [2, NOW, REV, 'dahmi', 'favorite', 'b'],
    ]);
    for (const entry of out) expect(entry.sql).toContain('WHERE user_id = ? AND kind = ? AND series_ref = ?');
  });

  it('refuses a reorder with an unknown kind or an empty list', () => {
    expect(translate('collection.reorder', { kind: 'watchlist', order: ['a'] })).toEqual([]);
    expect(translate('collection.reorder', { kind: 'favorite', order: [] })).toEqual([]);
    expect(translate('collection.reorder', { kind: 'favorite' })).toEqual([]);
  });
});

describe('library and recommendations carry the same descriptor', () => {
  it('records it on a library add', () => {
    const out = translate('library.add', {
      seriesRef: 's1',
      seriesTitle: 'Nano Machine',
      coverUrl: 'c',
      sourceId: 'src',
    });
    expect(out.some((entry) => entry.sql.includes('INSERT INTO works'))).toBe(true);
  });

  it('records it on a recommendation', () => {
    const out = translate('recommendation.send', {
      seriesRef: 's1',
      toId: 'ngm',
      seriesTitle: 'Nano Machine',
    });
    expect(out.some((entry) => entry.sql.includes('INSERT INTO works'))).toBe(true);
  });
});


describe('B8 recommendation recipient state', () => {
  it('creates one actionable recipient row and one social event for a targeted recommendation', () => {
    const out = translate('recommendation.send', {
      seriesRef: 's1',
      toId: 'ngm',
      message: 'شوفه',
    });

    const recipients = out.filter((entry) => entry.sql.includes('INSERT INTO recommendation_recipients'));
    expect(recipients).toHaveLength(1);
    expect(recipients[0]?.values).toEqual(['op-1', 'ngm', 'PENDING', REV]);

    const activity = out.find((entry) => entry.sql.includes('INSERT INTO activity'));
    expect(activity).toBeDefined();
    expect(activity?.values).toEqual(
      expect.arrayContaining(['op-1:activity', 'dahmi', 'RECOMMENDATION', 's1', 'ngm', 'vantara://series/s1']),
    );
  });

  it('creates independent recipient rows for every non-sender on a broadcast recommendation', () => {
    const out = translate('recommendation.send', { seriesRef: 's1', message: 'للجميع' });
    const recipients = out
      .filter((entry) => entry.sql.includes('INSERT INTO recommendation_recipients'))
      .map((entry) => entry.values[1]);

    expect(recipients).toEqual(['mansour', 'ngm']);
  });

  it('reject changes only the current recipient state and has no collection or library side effect', () => {
    const out = translate('recommendation.respond', {
      recommendationId: 'r1',
      state: 'REJECTED',
    });

    const response = out.find((entry) => entry.sql.includes('UPDATE recommendation_recipients'));
    expect(response).toBeDefined();
    expect(response?.sql).toContain('recommendation_id = ? AND user_id = ?');
    expect(response?.values).toContain('r1');
    expect(response?.values).toContain('dahmi');
    expect(out.some((entry) => entry.sql.includes('INSERT INTO collections'))).toBe(false);
    expect(out.some((entry) => entry.sql.includes('INSERT INTO library'))).toBe(false);
  });

  it('accept + WATCH_LATER derives the work from the recommendation, not client input', () => {
    const out = translate('recommendation.respond', {
      recommendationId: 'r1',
      state: 'ACCEPTED',
      intent: 'WATCH_LATER',
      // عميل معطوب/عدائي لا يختار عملًا آخر عبر الرد على توصية r1.
      seriesRef: 'evil-client-ref',
      seriesTitle: 'Fake',
    });

    const response = out.find((entry) => entry.sql.includes('UPDATE recommendation_recipients'));
    expect(response).toBeDefined();
    expect(response?.values).toContain('WATCH_LATER');

    const collection = out.find((entry) => entry.sql.includes('INSERT INTO collections'));
    expect(collection).toBeDefined();
    expect(collection?.sql).toContain('JOIN recommendations');
    expect(collection?.sql).toContain('recommendation_id');
    expect(collection?.values).toContain('read_later');
    expect(collection?.values).not.toContain('evil-client-ref');
  });

  it('accept + ADD_TO_LIBRARY records intent but does not invent a D1 library write', () => {
    const out = translate('recommendation.respond', {
      recommendationId: 'r1',
      state: 'ACCEPTED',
      intent: 'ADD_TO_LIBRARY',
      seriesRef: 's1',
    });

    expect(out.find((entry) => entry.sql.includes('UPDATE recommendation_recipients'))?.values).toContain(
      'ADD_TO_LIBRARY',
    );
    expect(out.some((entry) => entry.sql.includes('INSERT INTO library'))).toBe(false);
  });

  it('keeps acceptance separate from the later intent choice', () => {
    const accepted = translate('recommendation.respond', {
      recommendationId: 'r1',
      state: 'ACCEPTED',
    });
    const response = accepted.find((entry) => entry.sql.includes('UPDATE recommendation_recipients'));
    expect(response).toBeDefined();
    expect(response?.values).toContain('ACCEPTED');
    expect(accepted.some((entry) => entry.sql.includes('INSERT INTO collections'))).toBe(false);
    expect(accepted.some((entry) => entry.sql.includes('INSERT INTO library'))).toBe(false);
  });

  it('refuses malformed reject/intent combinations', () => {
    expect(
      translate('recommendation.respond', {
        recommendationId: 'r1',
        state: 'REJECTED',
        intent: 'WATCH_NOW',
      }),
    ).toEqual([]);
    expect(
      translate('recommendation.respond', {
        recommendationId: 'r1',
        state: 'ACCEPTED',
        intent: 'MAYBE',
      }),
    ).toEqual([]);
  });
});

describe('B8 server-derived activity', () => {
  it('derives rating activity from rating.set instead of requiring activity.add', () => {
    const out = translate('rating.set', { seriesRef: 's1', score: 9 });
    const activity = out.find((entry) => entry.sql.includes('INSERT INTO activity'));
    expect(activity).toBeDefined();
    expect(activity?.values).toEqual(
      expect.arrayContaining(['op-1:activity', 'dahmi', 'RATED_WORK', 's1', 'vantara://series/s1']),
    );
  });

  it('derives comment activity with a canonical comment deep link', () => {
    const out = translate('comment.add', {
      seriesRef: 'lookism',
      chapterRef: 'ch500',
      body: 'قوي',
    });
    const activity = out.find((entry) => entry.sql.includes('INSERT INTO activity'));
    expect(activity).toBeDefined();
    expect(activity?.values).toContain('vantara://series/lookism/comment/op-1');
  });

  it('notifies a parent comment author on a reply, excluding self', () => {
    const ctx = {
      accounts: ['dahmi', 'mansour', 'ngm'],
      comments: { parent1: { authorId: 'ngm', seriesRef: 's1' } },
    } as unknown as OpContext;
    const out = translate(
      'comment.add',
      { seriesRef: 's1', parentId: 'parent1', body: 'رد' },
      { ctx },
    );

    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification?.values).toContain('COMMENT_REPLY');
    expect(notification?.values).toContain('ngm');

    const selfCtx = {
      accounts: ['dahmi', 'mansour', 'ngm'],
      comments: { parent1: { authorId: 'dahmi', seriesRef: 's1' } },
    } as unknown as OpContext;
    const self = translate(
      'comment.add',
      { seriesRef: 's1', parentId: 'parent1', body: 'رد' },
      { ctx: selfCtx },
    );
    expect(
      self.some(
        (entry) =>
          entry.sql.includes('INSERT INTO notifications') && entry.values.includes('COMMENT_REPLY'),
      ),
    ).toBe(false);
  });

  it('routes top.set through the same collection path as favourites', () => {
    // «أفضل 5» (§9) مجموعةٌ مرتَّبة، لا جدولٌ ثالث: نفس الموضع ونفس
    // `collection.reorder` ونفس وصف العمل. نظامٌ موازٍ يعني شاشتين تختلفان.
    const out = translate('top.set', {
      seriesRef: 'src:test:vagabond',
      seriesTitle: 'فاجابوند',
      position: 0,
    });

    const collection = out.find((entry) => entry.sql.includes('INSERT INTO collections'));
    expect(collection?.values).toContain('top');
    expect(collection?.values).toContain('src:test:vagabond');
    // الوصف يرافق العضوية، وإلا عرضت الشاشة معرّفًا خامًا
    expect(out.some((entry) => entry.sql.includes('INSERT INTO works'))).toBe(true);
  });

  it('removes a work from the top list without touching favourites', () => {
    const out = translate('top.set', { seriesRef: 'src:test:x', member: false });
    const collection = out.find((entry) => entry.sql.includes('INSERT INTO collections'));
    expect(collection?.values).toContain('top');
    expect(collection?.values).toContain(0);
    expect(collection?.values).not.toContain('favorite');
  });

  it('stores the spoiler flag its author set, and nothing else as a spoiler', () => {
    const marked = translate('comment.add', {
      seriesRef: 'lookism',
      body: 'مات في الفصل 500',
      spoiler: true,
    });
    const insert = marked.find((entry) => entry.sql.includes('INSERT INTO comments'));
    expect(insert?.values).toContain(1);

    // حمولة مشوَّهة لا تصنع حرقًا ولا تُسقطه: `'true'` نصٌّ لا علامة
    const stray = translate('comment.add', {
      seriesRef: 'lookism',
      body: 'عادي',
      spoiler: 'true',
    });
    const plain = stray.find((entry) => entry.sql.includes('INSERT INTO comments'));
    expect(plain?.values).toContain(0);
  });

  it('never puts a spoiler body inside the reply notification', () => {
    // الإشعار لا زرّ كشف فيه: النصّ هناك يحرق بمجرد العرض. فالصفّ يُكتب بلا
    // نصٍّ من أصله — لا يُخفى في الواجهة.
    const ctx = {
      accounts: ['dahmi', 'mansour', 'ngm'],
      comments: { parent1: { authorId: 'ngm', seriesRef: 's1' } },
    } as unknown as OpContext;
    const out = translate(
      'comment.add',
      { seriesRef: 's1', parentId: 'parent1', body: 'مات في الفصل 500', spoiler: true },
      { ctx },
    );

    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification?.values).toContain('COMMENT_REPLY');
    expect(notification?.values).not.toContain('مات في الفصل 500');
    expect(notification?.values).toContain(null);
  });

  it('still carries an ordinary reply body into the notification', () => {
    // الحجب للمحروق وحده: حجبُ كل شيء يُفرّغ الإشعارات من معناها
    const ctx = {
      accounts: ['dahmi', 'mansour', 'ngm'],
      comments: { parent1: { authorId: 'ngm', seriesRef: 's1' } },
    } as unknown as OpContext;
    const out = translate(
      'comment.add',
      { seriesRef: 's1', parentId: 'parent1', body: 'ردّ عادي' },
      { ctx },
    );

    const notification = out.find((entry) => entry.sql.includes('INSERT INTO notifications'));
    expect(notification?.values).toContain('ردّ عادي');
  });

  it('keeps the comment activity free of the comment text', () => {
    // سجل النشاط سطحٌ آخر بلا كشف: يحمل المعرّف لا النصّ، محروقًا كان أو لا
    const out = translate('comment.add', {
      seriesRef: 'lookism',
      body: 'مات في الفصل 500',
      spoiler: true,
    });
    const activity = out.find((entry) => entry.sql.includes('INSERT INTO activity'));
    expect(JSON.stringify(activity?.values)).not.toContain('مات في الفصل 500');
  });

  it('derives reaction activity and notifies the comment author, excluding self', () => {
    const ctx = {
      accounts: ['dahmi', 'mansour', 'ngm'],
      comments: { c1: { authorId: 'mansour', seriesRef: 'lookism' } },
    } as unknown as OpContext;
    const out = translate('reaction.set', { commentId: 'c1', emoji: '🔥', active: true }, { ctx });

    const activity = out.find((entry) => entry.sql.includes('INSERT INTO activity'));
    expect(activity).toBeDefined();
    expect(activity?.values).toContain('vantara://series/lookism/comment/c1');

    const notification = out.find(
      (entry) =>
        entry.sql.includes('INSERT INTO notifications') && entry.values.includes('REACTION'),
    );
    expect(notification?.values).toContain('mansour');
  });

  it('creates one pending receipt row for each other account on a social event', () => {
    const out = translate('rating.set', { seriesRef: 's1', score: 9 });
    const receipts = out
      .filter((entry) => entry.sql.includes('INSERT INTO activity_receipts'))
      .map((entry) => entry.values[1]);
    expect(receipts).toEqual(['mansour', 'ngm']);
  });
});

describe('B8 delivery and seen receipts', () => {
  it('marks delivery only for the current viewer and does not rewrite an existing timestamp', () => {
    const [statement] = translate('activity.delivered', { eventId: 'event-1' }, { userId: 'ngm' });
    expect(statement?.sql).toContain('COALESCE(delivered_at');
    expect(statement?.sql).toContain('event_id = ? AND user_id = ?');
    expect(statement?.values).toContain('event-1');
    expect(statement?.values).toContain('ngm');
  });

  it('seen implies delivered and neither timestamp moves backwards', () => {
    const [statement] = translate('activity.seen', { eventId: 'event-1' }, { userId: 'ngm' });
    expect(statement?.sql).toContain('COALESCE(delivered_at');
    expect(statement?.sql).toContain('COALESCE(seen_at');
    expect(statement?.values).toContain('event-1');
    expect(statement?.values).toContain('ngm');
  });
});

describe('unknown ops', () => {
  it('produces nothing rather than throwing', () => {
    // الرفض بخطأ يوقف طابور العميل عند عملية واحدة إلى الأبد
    expect(translate('something.new', { anything: true })).toEqual([]);
  });
});
