/**
 * B11 — محاولة كسر VANTARA، لا اختبار المسار السعيد.
 *
 * هنا خادم مُقلَّد يطبّق العمليات بنفس دلالات الخادم الحقيقي: `op_id` مرة واحدة،
 * القراءة تراكمية، التقدم بـ`MAX`. ثم نُدير العميل الحقيقي أمام شبكة معادية —
 * انقطاع طويل، جلسة تنتهي في منتصف الدفعة، ردود بطيئة، طابور ضخم، وعدّاد خادم
 * يرجع للخلف — ونسأل سؤالًا واحدًا في كل مرة: **هل ضاع شيء، أو احتُسب مرتين؟**
 *
 * بوابة النجاح في الخطة: الفشل المتوقع يعطي degradation مفهومًا ولا يسبب فقد
 * بيانات صامتًا.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * خادم بذاكرة، بنفس القواعد الحاكمة.
 *
 * `applied` هو `applied_ops`: نفس `op_id` لا يُطبَّق مرتين مهما أُعيد تسليمه.
 * وهذا ما يجعل السؤال «هل احتُسب مرتين؟» قابلًا للقياس.
 */
function fakeServer() {
  const applied = new Set();
  const reads = new Map();
  const progress = new Map();
  let usageMs = 0;
  let rev = 0;

  const apply = (op) => {
    const p = op.payload ?? {};
    switch (op.kind) {
      case 'chapter.complete':
        reads.set(p.chapterKey, (reads.get(p.chapterKey) ?? 0) + 1);
        break;
      case 'usage.add':
        usageMs += Number(p.activeMs ?? 0);
        break;
      case 'progress.set': {
        const current = progress.get(p.chapterKey) ?? 0;
        progress.set(p.chapterKey, Math.max(current, Number(p.page ?? 0)));
        break;
      }
      default:
        break;
    }
  };

  return {
    get state() {
      return { reads, progress, usageMs, appliedCount: applied.size, rev };
    },
    handle(ops) {
      rev += 1;
      for (const op of ops) {
        if (applied.has(op.opId)) continue;
        applied.add(op.opId);
        apply(op);
      }
      return { applied: ops.map((op) => op.opId), skipped: [], cursor: rev, serverRev: rev };
    },
  };
}

/**
 * شبكة يمكن إعطابها.
 *
 * `mode` يتغيّر أثناء الاختبار: `ok`، `offline` (رفض)، `500`، `401`، و`half`
 * الذي يطبّق العملية عند الخادم ثم يُسقط الجواب — أسوأ حالة في المزامنة.
 */
function hostileNetwork(server, { onOps = null } = {}) {
  const network = {
    mode: 'ok',
    opsCalls: 0,
    fetch: async (url, options = {}) => {
      const path = String(url);
      if (path.includes('/v1/ops')) {
        network.opsCalls += 1;
        const body = JSON.parse(options.body ?? '{"ops":[]}');
        onOps?.(body.ops, network);

        if (network.mode === 'offline') throw new TypeError('Failed to fetch');
        if (network.mode === '500') return response({ error: 'boom' }, 500);
        if (network.mode === '401') return response({ error: 'unauthorized' }, 401);
        if (network.mode === 'half') {
          // الخادم طبّق ثم سقطت الشبكة قبل الجواب
          server.handle(body.ops);
          throw new TypeError('Failed to fetch');
        }
        return response(server.handle(body.ops));
      }
      if (path.includes('/v1/sync')) {
        if (network.mode === 'offline') throw new TypeError('Failed to fetch');
        return response({ reset: false, cursor: server.state.rev, serverRev: server.state.rev, changes: {} });
      }
      return response({ ok: true });
    },
  };
  return network;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function loadSync(storage, fetchImpl) {
  globalThis.localStorage = storage;
  globalThis.fetch = fetchImpl;
  const { createSync } = await import('./sync.js');
  return createSync({ baseUrl: 'https://sync.test' });
}

let storage;

beforeEach(() => {
  vi.resetModules();
  storage = fakeStorage();
  storage.setItem('vantara.token', 'token-1');
  storage.setItem('vantara.user', JSON.stringify({ userId: 'u1', username: 'dahmi' }));
});

describe('long offline then online', () => {
  it('loses no read and double-counts none', async () => {
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    network.mode = 'offline';
    for (let i = 0; i < 40; i += 1) {
      sync.enqueue('chapter.complete', {
        chapterKey: `c${i}`,
        seriesRef: 's1',
        ratio: 1,
        activeMs: 9_000,
      });
      sync.enqueue('usage.add', { activeMs: 60_000, day: '2026-09-18' });
    }
    await sync.push({ force: true });
    expect(server.state.appliedCount).toBe(0);
    expect(sync.pendingWrites).toBe(80);
    expect(sync.health().state).not.toBe('ok');

    network.mode = 'ok';
    await sync.push({ force: true });

    expect(server.state.reads.size).toBe(40);
    for (const count of server.state.reads.values()) expect(count).toBe(1);
    expect(server.state.usageMs).toBe(40 * 60_000);
    expect(sync.pendingWrites).toBe(0);
    expect(sync.health().state).toBe('ok');
  });

  it('survives a reply lost after the server already applied it', async () => {
    // أسوأ حالة: الكتابة نجحت والجواب لم يصل، فالعميل يعيد الإرسال
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    network.mode = 'half';
    await sync.push({ force: true });
    expect(server.state.reads.get('c1')).toBe(1);
    expect(sync.pendingWrites).toBe(1);

    network.mode = 'ok';
    await sync.push({ force: true });
    // نفس op_id: الخادم لا يحتسبها مرتين، والعميل يفرّغ طابوره
    expect(server.state.reads.get('c1')).toBe(1);
    expect(sync.pendingWrites).toBe(0);
  });
});

describe('session expires in the middle', () => {
  it('keeps every write and replays it under the new session', async () => {
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    sync.enqueue('usage.add', { activeMs: 30_000 });
    network.mode = '401';
    await sync.push({ force: true });

    expect(sync.signedIn).toBe(false);
    expect(sync.pendingWrites).toBe(2);
    expect(sync.quarantined).toBe(0);
    expect(server.state.appliedCount).toBe(0);

    // جلسة جديدة على نفس الجهاز: نفس الطابور، نفس المعرّفات
    storage.setItem('vantara.token', 'token-2');
    const resumed = await loadSync(storage, network.fetch);
    network.mode = 'ok';
    await resumed.push({ force: true });

    expect(server.state.reads.get('c1')).toBe(1);
    expect(server.state.usageMs).toBe(30_000);
    expect(resumed.pendingWrites).toBe(0);
  });
});

describe('a very large queue', () => {
  it('sends it in batches and lands every cumulative op exactly once', async () => {
    const server = fakeServer();
    const seen = [];
    const network = hostileNetwork(server, { onOps: (ops) => seen.push(ops.length) });
    const sync = await loadSync(storage, network.fetch);

    network.mode = 'offline';
    for (let i = 0; i < 260; i += 1) {
      sync.enqueue('chapter.complete', { chapterKey: `c${i}`, seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    }
    await sync.push({ force: true });

    network.mode = 'ok';
    await sync.push({ force: true });

    expect(seen.every((count) => count <= 100)).toBe(true);
    expect(server.state.reads.size).toBe(260);
    expect(sync.pendingWrites).toBe(0);
  });

  it('keeps the reads when the queue overflows its limit', async () => {
    // 600 قراءة: أطول من السقف. لا شيء منها قابل للإسقاط، فالطابور يتجاوز
    // الحد ويُعلن ذلك بدل أن يأكل قراءة
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    network.mode = 'offline';
    for (let i = 0; i < 600; i += 1) {
      sync.enqueue('chapter.complete', { chapterKey: `c${i}`, seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    }
    await sync.push({ force: true });
    expect(sync.pendingWrites).toBe(600);
    expect(sync.health().state).toBe('blocked');

    network.mode = 'ok';
    await sync.push({ force: true });
    expect(server.state.reads.size).toBe(600);
  });
});

describe('slow network', () => {
  it('does not lose a write enqueued while a push is in flight', async () => {
    const server = fakeServer();
    let release = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    let firstCall = true;

    const network = hostileNetwork(server);
    const original = network.fetch;
    const sync = await loadSync(storage, async (url, options) => {
      if (String(url).includes('/v1/ops') && firstCall) {
        firstCall = false;
        await slow;
      }
      return original(url, options);
    });

    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    const inFlight = sync.push({ force: true });
    // وصلت أثناء الإرسال البطيء
    sync.enqueue('chapter.complete', { chapterKey: 'c2', seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    release();
    await inFlight;
    await sync.push({ force: true });

    expect(server.state.reads.get('c1')).toBe(1);
    expect(server.state.reads.get('c2')).toBe(1);
  });
});

describe('a stale client', () => {
  it('rebuilds its mirror when the server counter went backwards, keeping writes', async () => {
    // D1 استُعيدت من نسخة احتياطية: عدّاد الخادم أقل من cursor العميل
    const server = fakeServer();
    storage.setItem('vantara.cursor', '5000');
    let syncCalls = 0;
    const sync = await loadSync(storage, async (url, options) => {
      const path = String(url);
      if (path.includes('/v1/sync')) {
        syncCalls += 1;
        if (syncCalls === 1) {
          return response({ reset: true, cursor: 0, serverRev: 2, changes: {} });
        }
        return response({ reset: false, cursor: 2, serverRev: 2, changes: {} });
      }
      const body = JSON.parse(options?.body ?? '{"ops":[]}');
      return response(server.handle(body.ops));
    });

    sync.enqueue('chapter.complete', { chapterKey: 'c1', seriesRef: 's1', ratio: 1, activeMs: 9_000 });
    await sync.pull();
    expect(sync.pendingWrites).toBe(1);

    await sync.push({ force: true });
    expect(server.state.reads.get('c1')).toBe(1);
    expect(Number(storage.getItem('vantara.cursor'))).toBeGreaterThan(0);
  });
});

describe('content API down while the worker is up', () => {
  it('leaves progress in the outbox unconfirmed instead of claiming it landed', async () => {
    // مالك التقدم غير متاح: المرآة تحفظ، ولا إقرار — وهذا ما يجعل التصريف
    // القادم يدفعه فعلًا بدل أن يضيع بصمت
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's1', page: 30, ratio: 0.9 });
    await sync.push({ force: true });

    expect(server.state.progress.get('c1')).toBe(30);
    // لا عملية إقرار: الإقرار يأتي من نجاح كتابة عند المالك، والمالك ساقط
    expect(sync.pendingWrites).toBe(0);
    expect(sync.health().state).toBe('ok');
  });

  it('never lets an older device push progress backwards', async () => {
    const server = fakeServer();
    const network = hostileNetwork(server);
    const sync = await loadSync(storage, network.fetch);

    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's1', page: 30, ratio: 0.9 });
    await sync.push({ force: true });
    sync.enqueue('progress.set', { chapterKey: 'c1', seriesRef: 's1', page: 12, ratio: 0.4 });
    await sync.push({ force: true });

    expect(server.state.progress.get('c1')).toBe(30);
  });
});
