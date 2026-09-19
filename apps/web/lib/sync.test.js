/**
 * اختبارات عميل المزامنة نفسه، لا قواعده وحدها.
 *
 * `queue.test.js` يثبت القواعد النقية. هذا يثبت أن العميل يطبّقها على طابور
 * حقيقي وشبكة تفشل: التراجع، والعزل، وألا يمسح إعادةُ بناء الخادم كتاباتٍ لم
 * تُرسل بعد. هذه المسارات لا تظهر في اختبار دالة نقية، وهي تمامًا حيث يضيع
 * عمل المستخدم.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** `localStorage` في الذاكرة، مع سقف اختياري لمحاكاة الامتلاء. */
function fakeStorage({ failOn = null } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (failOn && failOn(key, value)) {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
}

const SIGNED_IN = { userId: 'u1', username: 'dahmi', displayName: 'دحمي' };

async function loadSync({ storage, fetchImpl }) {
  globalThis.localStorage = storage;
  globalThis.fetch = fetchImpl;
  const { createSync } = await import('./sync.js');
  return createSync({ baseUrl: 'https://sync.test' });
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    // `Response` الحقيقي يحمل `headers` دائمًا. نموذجٌ بلا هذا يجعل أي كود
    // يقرأ ترويسةً يسقط في الاختبار وحده — وقد سقط فعلًا حين قرأنا معرّف
    // الربط، فبدا العطل في المزامنة وهو في النموذج.
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

let storage;

beforeEach(() => {
  vi.resetModules();
  storage = fakeStorage();
  storage.setItem('vantara.token', 'token-1');
  storage.setItem('vantara.user', JSON.stringify(SIGNED_IN));
});

describe('queue durability', () => {
  it('keeps unsent writes when the server asks for a full resync', async () => {
    // D1 استُعيدت من نسخة احتياطية فرجع عدّادها. الكود القديم كان يمسح الطابور
    // مع المرآة: كتابات المستخدم غير المرسلة تضيع لسبب لا علاقة له بها.
    storage.setItem('vantara.cursor', '90');
    let syncCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/v1/sync')) {
        syncCalls += 1;
        if (syncCalls === 1) return jsonResponse({ reset: true, cursor: 0, serverRev: 3, changes: {} });
        return jsonResponse({ reset: false, cursor: 3, serverRev: 3, changes: {} });
      }
      // لا نريد إرسالًا في هذا الاختبار: نعطّل الشبكة لمسار الكتابة
      return jsonResponse({ error: 'down' }, 500);
    });

    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's', ratio: 1, activeMs: 9000 });
    await sync.pull();

    expect(sync.pendingWrites).toBe(1);
    expect(JSON.parse(storage.getItem('vantara.queue'))).toHaveLength(1);
  });

  it('never drops a read chapter to make room in a full queue', async () => {
    // العيب القديم: الطابور الممتلئ يُسقط الأقدم. الأقدم هنا فصلٌ قُرئ فعلًا،
    // وهو تمامًا ما لا يُستعاد — بينما مئات عمليات الحالة بعده تصححها أول
    // كتابة قادمة.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'down' }, 500));
    const sync = await loadSync({ storage, fetchImpl });

    sync.enqueue('chapter.complete', { chapterKey: 'precious', seriesRef: 's', ratio: 1, activeMs: 9000 });
    for (let i = 0; i < 500; i += 1) {
      sync.enqueue('favorite.set', { seriesRef: `series-${i}`, member: true });
    }

    const saved = JSON.parse(storage.getItem('vantara.queue'));
    expect(saved).toHaveLength(500);
    expect(saved.some((op) => op.payload.chapterKey === 'precious')).toBe(true);
  });

  it('frees the mirror to save a write when local storage is full', async () => {
    // المرآة مشتقة من الخادم وتُسحب من جديد. الكتابة غير المرسلة لا يملكها
    // غيرنا، فهي آخر ما يُفقد لا أوّله.
    const full = fakeStorage({
      failOn: (key) => key === 'vantara.queue' && !full.map.has('__freed__'),
    });
    full.setItem('vantara.token', 'token-1');
    full.setItem('vantara.mirror', JSON.stringify({ library: { a: { series_ref: 'a' } } }));
    const originalRemove = full.removeItem;
    full.removeItem = (key) => {
      if (key === 'vantara.mirror') full.map.set('__freed__', '1');
      return originalRemove(key);
    };

    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'down' }, 500));
    const sync = await loadSync({ storage: full, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 60_000, day: '2026-09-17' });

    expect(full.map.has('vantara.mirror')).toBe(false);
    expect(JSON.parse(full.getItem('vantara.queue'))).toHaveLength(1);
    expect(sync.health().state).not.toBe('degraded');
  });

  it('reports degraded storage when even an empty mirror does not help', async () => {
    const full = fakeStorage({ failOn: (key) => key === 'vantara.queue' });
    full.setItem('vantara.token', 'token-1');
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'down' }, 500));
    const sync = await loadSync({ storage: full, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    expect(sync.health().state).toBe('degraded');
  });
});

describe('retry and backoff', () => {
  it('stops hammering a failing server and resumes when forced', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/v1/sync')) return jsonResponse({ reset: false, cursor: 1, changes: {} });
      return jsonResponse({ error: 'boom' }, 500);
    });
    const sync = await loadSync({ storage, fetchImpl });

    const opsCalls = () => fetchImpl.mock.calls.filter((call) => String(call[0]).includes('/v1/ops')).length;

    sync.enqueue('usage.add', { activeMs: 1000 });
    await Promise.resolve();
    // التجميع: الكتابة لا تُرسل في نفس اللحظة، فتلحق بها الكتابات المتلاحقة
    expect(opsCalls()).toBe(0);

    await sync.push({ force: true });
    expect(opsCalls()).toBe(1);

    // فشل 500 يضع تراجعًا: الدورة الزمنية لا تحاول الآن
    await sync.push();
    expect(opsCalls()).toBe(1);

    // ضغطة المستخدم تتجاوز التراجع
    await sync.push({ force: true });
    expect(opsCalls()).toBe(2);
    expect(sync.pendingWrites).toBe(1);
  });

  it('keeps the write and the session intact on a 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's', ratio: 1, activeMs: 9000 });
    await sync.push({ force: true });

    // الجلسة انتهت لا العملية فسدت: لا عزل، والكتابة تنتظر جلسة جديدة
    expect(sync.quarantined).toBe(0);
    expect(sync.pendingWrites).toBe(1);
    expect(sync.signedIn).toBe(false);
  });
});

describe('B2 auth + B5 queue integration', () => {
  it('refreshes an expired session and resends the same queued write without quarantine', async () => {
    let opsCalls = 0;
    let sessionCalls = 0;
    const authHeaders = [];

    const fetchImpl = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/v1/session')) {
        sessionCalls += 1;
        const body = JSON.parse(String(options.body));
        expect(body.userId).toBe('u1');
        expect(typeof body.deviceId).toBe('string');
        expect(typeof body.deviceCredential).toBe('string');
        return jsonResponse({ token: 'token-2', user: SIGNED_IN });
      }
      if (value.includes('/v1/ops')) {
        opsCalls += 1;
        authHeaders.push(options.headers?.authorization);
        if (opsCalls === 1) return jsonResponse({ error: 'expired' }, 401);
        const ops = JSON.parse(String(options.body)).ops;
        return jsonResponse({ applied: ops.map((entry) => entry.opId), skipped: [], cursor: 2 });
      }
      if (value.includes('/v1/sync')) {
        return jsonResponse({ reset: false, cursor: 2, changes: {} });
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    await sync.push({ force: true });

    expect(sessionCalls).toBe(1);
    expect(opsCalls).toBe(2);
    expect(authHeaders).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(sync.pendingWrites).toBe(0);
    expect(sync.quarantined).toBe(0);
    expect(sync.signedIn).toBe(true);
    expect(storage.getItem('vantara.token')).toBe('token-2');
  });
});

describe('quarantine', () => {
  it('quarantines an op the server rejects outright', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/v1/ops')) return jsonResponse({ error: 'bad_request' }, 400);
      return jsonResponse({ reset: false, cursor: 1, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    await sync.push({ force: true });

    expect(sync.quarantined).toBe(1);
    expect(sync.pendingWrites).toBe(0);
    expect(sync.health().state).toBe('blocked');
  });

  it('quarantines an op a successful response never mentions', async () => {
    // الخادم يُسقط عملية لا يستطيع تحليلها ولا يذكرها في applied. إبقاؤها في
    // الطابور يعني محاولة أبدية وكتابة معلّقة لا تنتهي.
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/v1/ops')) return jsonResponse({ applied: [], skipped: [], cursor: 5 });
      return jsonResponse({ reset: false, cursor: 5, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    await sync.push({ force: true });

    expect(sync.quarantined).toBe(1);
    expect(sync.pendingWrites).toBe(0);
  });

  it('puts a quarantined op back when the user asks', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/v1/ops')) return jsonResponse({ error: 'bad_request' }, 400);
      return jsonResponse({ reset: false, cursor: 1, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    await sync.push({ force: true });
    expect(sync.quarantined).toBe(1);

    const revived = sync.retryQuarantined();
    expect(revived).toBe(1);
    expect(sync.quarantined).toBe(0);
  });
});

describe('push', () => {
  it('compacts the queue before sending it', async () => {
    let sent = null;
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).includes('/v1/ops')) {
        sent = JSON.parse(options.body).ops;
        return jsonResponse({ applied: sent.map((op) => op.opId), skipped: [], cursor: 9 });
      }
      return jsonResponse({ reset: false, cursor: 9, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });

    // ثلاث كتابات تقدم لنفس الفصل: الخادم يحتاج الأعلى منها فقط
    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's', page: 4, ratio: 0.1 });
    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's', page: 30, ratio: 0.9 });
    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's', page: 12, ratio: 0.4 });
    await sync.push({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ page: 30, ratio: 0.9 });
    expect(sync.pendingWrites).toBe(0);
    expect(sync.health().state).toBe('ok');
  });

  it('records the last successful sync', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).includes('/v1/ops')) {
        const ops = JSON.parse(options.body).ops;
        return jsonResponse({ applied: ops.map((op) => op.opId), skipped: [], cursor: 2 });
      }
      return jsonResponse({ reset: false, cursor: 2, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });
    sync.enqueue('usage.add', { activeMs: 1000 });
    await sync.push({ force: true });
    expect(Number(storage.getItem('vantara.lastPush'))).toBeGreaterThan(0);
  });
});

/**
 * سطح الهوية الذي يستهلكه خادم المحتوى.
 *
 * `lib/content-api.js` يقرأ الترويسة من هنا ويطلب التجديد من هنا. لو كان
 * السطح قيمةً تُقرأ مرة واحدة لأُرسلت ترويسة حسابٍ سابق بعد تبديل الحساب،
 * ولو غاب التجديد لسجّل التطبيق خروجًا في وجه القارئ في منتصف فصل.
 *
 * كُتبت في B3 على `signIn`، وأُعيد توجيهها هنا إلى عقد B2: التجديد يمرّ بإثبات
 * الجهاز. النية لم تتغيّر — التأكيد وحده تبع التنفيذ الأصحّ.
 */
describe('the identity seam the content api reads', () => {
  it('exposes the header only while signed in', async () => {
    const sync = await loadSync({ storage, fetchImpl: vi.fn(async () => jsonResponse({})) });
    expect(sync.authorizationHeader).toBe('Bearer token-1');

    sync.signOut();
    expect(sync.authorizationHeader).toBeNull();
    expect(sync.signedIn).toBe(false);
  });

  it('follows the token when it is rotated, rather than freezing at boot', async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes('/v1/session')
        ? jsonResponse({ token: 'token-2', user: SIGNED_IN })
        : jsonResponse({ reset: false, cursor: 0, changes: {} }),
    );
    const sync = await loadSync({ storage, fetchImpl });
    expect(sync.authorizationHeader).toBe('Bearer token-1');

    await sync.refreshSession();
    expect(sync.authorizationHeader).toBe('Bearer token-2');
  });

  it('refreshes through device proof, and asks the reader for nothing', async () => {
    // اختيار الحساب هو الدخول: التجديد لا يعرض شاشة ولا يطلب سرًّا — لكنه
    // **يثبت الجهاز**، وهذا ما يمنع من يعرف عنوان الـWorker من انتحال حساب
    const bodies = [];
    const fetchImpl = vi.fn(async (url, options) => {
      if (String(url).includes('/v1/session')) {
        bodies.push(JSON.parse(options.body));
        return jsonResponse({ token: 'token-2', user: SIGNED_IN });
      }
      return jsonResponse({ reset: false, cursor: 0, changes: {} });
    });
    const sync = await loadSync({ storage, fetchImpl });

    await expect(sync.refreshSession()).resolves.toMatchObject({ token: 'token-2' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].userId).toBe('u1');
    expect(typeof bodies[0].deviceId).toBe('string');
    expect(typeof bodies[0].deviceCredential).toBe('string');
  });

  it('keeps the mirror when refreshing, since the account did not change', async () => {
    // مسح المرآة عند كل تجديد يعني شاشة فارغة كل خمس عشرة دقيقة
    storage.setItem('vantara.cursor', '42');
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes('/v1/session')
        ? jsonResponse({ token: 'token-2', user: SIGNED_IN })
        : jsonResponse({ reset: false, cursor: 42, changes: {} }),
    );
    const sync = await loadSync({ storage, fetchImpl });

    await sync.refreshSession();
    expect(storage.getItem('vantara.cursor')).toBe('42');
  });

  it('refuses with 401 when there is no account to refresh', async () => {
    // لا يتظاهر بالنجاح: عقد B2 يرمي، و`content-api` يلتقط ويُبلّغ 401 الأصلي.
    // كان عقدي يرجع `false` بهدوء — وهو أسوأ، لأن الصامت يمرّ بلا معالجة.
    storage.removeItem('vantara.user');
    storage.removeItem('vantara.token');
    const sync = await loadSync({ storage, fetchImpl: vi.fn(async () => jsonResponse({})) });
    await expect(sync.refreshSession()).rejects.toMatchObject({ status: 401 });
  });

  it('folds the session when the refresh fails on the network', async () => {
    // هذا ما كان ناقصًا في عقدي: تجديد فاشل يجب أن يُنهي دعوى «مسجَّل الدخول»،
    // وإلا بقيت الواجهة تعرض حسابًا لا توكن له وتفشل كل نداء بلا تفسير
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const sync = await loadSync({ storage, fetchImpl });
    await expect(sync.refreshSession()).rejects.toThrow('offline');
    expect(sync.signedIn).toBe(false);
    expect(sync.authorizationHeader).toBeNull();
  });
});
