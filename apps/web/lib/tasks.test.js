/**
 * B13 — الجدولة والإلغاء وإزالة التكرار.
 *
 * المعيار هنا ليس «هل نجحت المهمة» بل «ماذا حدث للواجهة أثناءها». ولذلك كل
 * اختبار يسأل سؤالًا من سلوك المستخدم: هل سبقت الصفحة التي ينظر إليها ما
 * يُسخَّن خلفه؟ هل توقف العمل حين لمس؟ هل مات ما تركه؟ هل دفع ثمن نفس
 * البايتات مرتين؟
 */
import { describe, expect, it, vi } from 'vitest';
import { PRIORITY, createGenerations, createInFlight, createScheduler } from './tasks.js';

/** ساعة يدوية: الاختبار يقرّر الزمن، فلا نعلّق على مؤقّتات حقيقية. */
function manualClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

const immediateYield = () => Promise.resolve();

describe('scheduler priority', () => {
  it('takes the reader page before the prefetch that was queued first', async () => {
    // الترتيب بالوصول يعني أن تسخينًا أُضيف أولًا يؤخّر الصفحة المعروضة الآن
    const scheduler = createScheduler({ yieldFn: immediateYield });
    const order = [];

    const first = scheduler.run(async () => order.push('prefetch'), {
      priority: PRIORITY.prefetch,
    });
    const second = scheduler.run(async () => order.push('current'), {
      priority: PRIORITY.current,
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['current', 'prefetch']);
  });

  it('keeps first-in order inside one priority', async () => {
    const scheduler = createScheduler({ yieldFn: immediateYield });
    const order = [];
    await Promise.all([
      scheduler.run(async () => order.push('a'), { priority: PRIORITY.delta }),
      scheduler.run(async () => order.push('b'), { priority: PRIORITY.delta }),
      scheduler.run(async () => order.push('c'), { priority: PRIORITY.delta }),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('returns what the task returned, not a wrapper', async () => {
    const scheduler = createScheduler({ yieldFn: immediateYield });
    await expect(scheduler.run(async () => 42, { priority: PRIORITY.current })).resolves.toBe(42);
  });

  it('a failing task does not stop the queue behind it', async () => {
    // مهمة تسخين فشلت يجب ألا تُجمّد فروقات المكتبة خلفها
    const scheduler = createScheduler({ yieldFn: immediateYield });
    const done = [];

    // القياس داخل جسم المهمة لا في معالج الرفض: ترتيب المعالجات يتبع
    // microtasks لا ترتيب التنفيذ، واختبارٌ يقيسه يقيس شيئًا آخر
    const failing = scheduler.run(
      async () => {
        done.push('failing');
        throw new Error('source down');
      },
      { priority: PRIORITY.prefetch },
    );
    const after = scheduler.run(async () => done.push('ran'), { priority: PRIORITY.prefetch });

    await expect(failing).rejects.toThrow('source down');
    await after;
    expect(done).toEqual(['failing', 'ran']);
  });
});

describe('yielding to the user', () => {
  it('holds background work back after a touch, and still runs the current page', async () => {
    // هذه هي القاعدة كلها: اللمسة توقف ما دونها، ولا توقف ما ينظر إليه
    const clock = manualClock();
    const scheduler = createScheduler({ yieldFn: immediateYield, clock: clock.now });
    const order = [];

    scheduler.noteInteraction();
    expect(scheduler.yielding).toBe(true);

    const prefetch = scheduler.run(async () => order.push('prefetch'), {
      priority: PRIORITY.prefetch,
    });
    const current = scheduler.run(async () => order.push('current'), {
      priority: PRIORITY.current,
    });

    await current;
    expect(order).toEqual(['current']);

    // انقضاء مدة التنازل يُفرج عن الخلفي بلا تدخل
    clock.advance(500);
    await prefetch;
    expect(order).toEqual(['current', 'prefetch']);
  });

  it('does not lose the held work — it resumes, it is not dropped', async () => {
    const clock = manualClock();
    const scheduler = createScheduler({ yieldFn: immediateYield, clock: clock.now });

    scheduler.noteInteraction();
    const held = scheduler.run(async () => 'done', { priority: PRIORITY.maintenance });
    expect(scheduler.pending).toBe(1);

    clock.advance(401);
    await expect(held).resolves.toBe('done');
    expect(scheduler.pending).toBe(0);
  });

  it('stops yielding once the quiet window passes', async () => {
    const clock = manualClock();
    const scheduler = createScheduler({ yieldFn: immediateYield, clock: clock.now });
    scheduler.noteInteraction();
    clock.advance(400);
    expect(scheduler.yielding).toBe(false);
  });
});

describe('cancellation', () => {
  it('rejects a task whose signal aborted before it ran', async () => {
    const scheduler = createScheduler({ yieldFn: immediateYield });
    const controller = new AbortController();
    controller.abort();

    const ran = vi.fn();
    await expect(
      scheduler.run(ran, { priority: PRIORITY.prefetch, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // لم تبدأ أصلًا: الإلغاء يمنع العمل، لا يوقفه بعد أن كلّف
    expect(ran).not.toHaveBeenCalled();
  });

  it('hands the signal to the task so it can abort its own fetch', async () => {
    const scheduler = createScheduler({ yieldFn: immediateYield });
    const controller = new AbortController();
    let seen = null;

    await scheduler.run(
      async ({ signal }) => {
        seen = signal;
      },
      { priority: PRIORITY.current, signal: controller.signal },
    );

    expect(seen).toBe(controller.signal);
  });
});

describe('generations', () => {
  it('marks the previous generation stale when the user moves on', () => {
    // نتيجة وصلت قبل الإلغاء يجب ألا تُرسم على شاشة تبدّلت
    const generations = createGenerations();
    const mangaA = generations.next();
    expect(mangaA.current()).toBe(true);

    const mangaB = generations.next();
    expect(mangaA.current()).toBe(false);
    expect(mangaB.current()).toBe(true);
  });

  it('aborts the previous signal when a new generation starts', () => {
    const generations = createGenerations();
    const first = generations.next();
    expect(first.signal?.aborted).toBe(false);

    generations.next();
    expect(first.signal?.aborted).toBe(true);
  });

  it('cancel leaves nothing current', () => {
    const generations = createGenerations();
    const live = generations.next();
    generations.cancel();
    expect(live.current()).toBe(false);
    expect(live.signal?.aborted).toBe(true);
  });
});

describe('in-flight deduplication', () => {
  it('asks the network once when three callers want the same page', async () => {
    // القارئ والتسخين والصفحة التالية يطلبون نفس الصفحة في نفس اللحظة
    const inFlight = createInFlight();
    const fetchPage = vi.fn(async () => 'bytes');

    const [a, b, c] = await Promise.all([
      inFlight.run('chapter-84/page-01', fetchPage),
      inFlight.run('chapter-84/page-01', fetchPage),
      inFlight.run('chapter-84/page-01', fetchPage),
    ]);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(['bytes', 'bytes', 'bytes']);
  });

  it('keeps different resources apart', async () => {
    const inFlight = createInFlight();
    const fetchPage = vi.fn(async (key) => key);
    await Promise.all([
      inFlight.run('page-01', () => fetchPage('page-01')),
      inFlight.run('page-02', () => fetchPage('page-02')),
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not cache the failure — a later caller gets a real retry', async () => {
    // انقطاع لحظي يجب ألا يتحوّل إلى فشل محفوظ يُعاد لكل من يسأل
    const inFlight = createInFlight();
    let attempt = 0;
    const load = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('offline');
      return 'bytes';
    };

    await expect(inFlight.run('page-01', load)).rejects.toThrow('offline');
    await expect(inFlight.run('page-01', load)).resolves.toBe('bytes');
    expect(attempt).toBe(2);
  });

  it('releases the slot once settled', async () => {
    const inFlight = createInFlight();
    await inFlight.run('page-01', async () => 'bytes');
    expect(inFlight.size).toBe(0);
  });

  it('survives a factory that throws synchronously', async () => {
    const inFlight = createInFlight();
    await expect(
      inFlight.run('page-01', () => {
        throw new Error('bad key');
      }),
    ).rejects.toThrow('bad key');
    expect(inFlight.size).toBe(0);
  });
});
