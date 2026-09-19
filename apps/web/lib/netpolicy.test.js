/**
 * B13 — سياسة التنزيل حسب الشبكة.
 *
 * السؤال الذي تجيب عنه هذه الاختبارات ليس «هل الدالة ترجع كائنًا» بل: هل
 * يستطيع التطبيق أن يستهلك بيانات جوال ضحمي بلا إذنه؟ وهل يعاقب مستخدم
 * iPhone لأن متصفحه لا يفصح عن نوع الشبكة؟
 */
import { describe, expect, it, vi } from 'vitest';
import { createNetworkPolicy, prefetchBudget, readNetwork } from './netpolicy.js';

const navWith = (connection, online = true) => ({ onLine: online, connection });

describe('reading the network', () => {
  it('treats a missing Connection API as unknown, not as bad or good', () => {
    // Safari/iOS لا يعرّف `navigator.connection` إطلاقًا
    expect(readNetwork({ onLine: true })).toEqual({
      online: true,
      kind: 'unknown',
      saveData: false,
    });
  });

  it('reads wifi and cellular when the browser does say', () => {
    expect(readNetwork(navWith({ type: 'wifi' })).kind).toBe('unmetered');
    expect(readNetwork(navWith({ type: 'cellular' })).kind).toBe('metered');
  });

  it('treats a slow generation as metered even with no connection type', () => {
    // أغلب المتصفحات لا تعطي `type`؛ و2g/3g بطء مؤكد مهما كان الوسط
    expect(readNetwork(navWith({ effectiveType: '2g' })).kind).toBe('metered');
    expect(readNetwork(navWith({ effectiveType: '4g' })).kind).toBe('unknown');
  });

  it('survives having no navigator at all', () => {
    expect(readNetwork(undefined).online).toBe(true);
  });
});

describe('the budget the policy hands out', () => {
  it('asks for nothing at all when offline', () => {
    // دون اتصال وضع تشغيل كامل، لا خطأ: المحلي يُقرأ ولا يُطلب شيء
    const budget = prefetchBudget({ network: { online: false, kind: 'unmetered' } });
    expect(budget).toMatchObject({ metadata: false, pages: 0, chapters: 0, images: false });
  });

  it('prefetches generously on a known unmetered network', () => {
    const budget = prefetchBudget({ network: { online: true, kind: 'unmetered' } });
    expect(budget.chapters).toBeGreaterThan(0);
    expect(budget.pages).toBeGreaterThanOrEqual(4);
  });

  it('stops prefetching whole chapters on mobile data', () => {
    // هذا هو البند كله: لا يفاجأ أحد بثلاثة جيجا من فاتورته
    const budget = prefetchBudget({ network: { online: true, kind: 'metered' } });
    expect(budget.chapters).toBe(0);
    expect(budget.metadata).toBe(true);
    expect(budget.pages).toBeLessThanOrEqual(1);
  });

  it('takes the conservative middle when the network is unknown', () => {
    // لا يُعاقب مستخدم iPhone بحرمانه، ولا يُخاطر بفاتورته
    const budget = prefetchBudget({ network: { online: true, kind: 'unknown' } });
    expect(budget.chapters).toBe(0);
    expect(budget.pages).toBe(2);
    expect(budget.reason).toBe('unknown_network');
  });

  it('honours the system data-saver over any guess', () => {
    const budget = prefetchBudget({
      network: { online: true, kind: 'unmetered', saveData: true },
    });
    expect(budget.reason).toBe('save_data');
    expect(budget.chapters).toBe(0);
  });
});

describe('what the user chose wins', () => {
  it('never means never, even on wifi', () => {
    const budget = prefetchBudget({
      mode: 'never',
      network: { online: true, kind: 'unmetered' },
    });
    expect(budget).toMatchObject({ metadata: false, pages: 0, chapters: 0 });
  });

  it('always means always, even on mobile data', () => {
    const budget = prefetchBudget({ mode: 'always', network: { online: true, kind: 'metered' } });
    expect(budget.chapters).toBeGreaterThan(0);
    expect(budget.reason).toBe('user_always');
  });

  it('always still cannot invent a network when offline', () => {
    const budget = prefetchBudget({ mode: 'always', network: { online: false, kind: 'unmetered' } });
    expect(budget.reason).toBe('offline');
  });

  it('wifi-only refuses to guess: unknown is not wifi', () => {
    // «Wi-Fi فقط» تعني شبكة غير محدودة مؤكَّدة؛ والمجهول ليس مؤكَّدًا
    const budget = prefetchBudget({ mode: 'wifi', network: { online: true, kind: 'unknown' } });
    expect(budget.pages).toBe(0);
    // البيانات الوصفية تبقى: هي ما يُظهر «٣ فصول جديدة» وحجمها لا يُذكر
    expect(budget.metadata).toBe(true);
    expect(budget.reason).toBe('wifi_only_not_wifi');
  });

  it('wifi-only opens up on confirmed wifi', () => {
    const budget = prefetchBudget({ mode: 'wifi', network: { online: true, kind: 'unmetered' } });
    expect(budget.chapters).toBeGreaterThan(0);
  });
});

describe('the live policy', () => {
  it('re-reads the network instead of freezing the first answer', () => {
    // المستخدم يخرج من البيت والفصل يُسخَّن: الميزانية يجب أن تتبعه
    const connection = { type: 'wifi' };
    const policy = createNetworkPolicy({ nav: navWith(connection) });
    expect(policy.budget().chapters).toBeGreaterThan(0);

    connection.type = 'cellular';
    expect(policy.budget().chapters).toBe(0);
  });

  it('rejects an unknown mode instead of applying it', () => {
    const policy = createNetworkPolicy({ nav: navWith(null) });
    expect(policy.setMode('unlimited-everything')).toBe(false);
    expect(policy.mode).toBe('smart');
  });

  it('tells subscribers when the mode changes', () => {
    const policy = createNetworkPolicy({ nav: navWith({ type: 'wifi' }) });
    const seen = vi.fn();
    policy.subscribe(seen);
    policy.setMode('never');
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_never' }));
  });

  it('a broken subscriber does not stop the others', () => {
    const policy = createNetworkPolicy({ nav: navWith(null) });
    policy.subscribe(() => {
      throw new Error('bad listener');
    });
    const good = vi.fn();
    policy.subscribe(good);
    policy.setMode('always');
    expect(good).toHaveBeenCalled();
  });

  it('defaults to smart when handed nonsense', () => {
    expect(createNetworkPolicy({ mode: 'turbo', nav: navWith(null) }).mode).toBe('smart');
  });
});
