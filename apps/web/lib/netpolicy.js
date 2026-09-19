/**
 * كم يُسمح للتطبيق أن ينزّل خلفك، وعلى أي شبكة.
 *
 * المشكلة التي تحلّها هذه الوحدة ليست تقنية: ضحمي يفتح VANTARA على بيانات
 * جواله، والتطبيق يبدأ تسخين فصول لم يطلبها. لا شيء «يفشل» — وهذا بالضبط
 * سوء الحالة: الخلل يظهر في فاتورة لا في شاشة.
 *
 * ثلاث قواعد:
 *
 * 1. **الافتراض عند الجهل ليس التوسّع.** `navigator.connection` غير موجود على
 *    Safari/iOS إطلاقًا. فحين لا نعرف نوع الشبكة، نأخذ الوسط المحافظ لا
 *    الأقصى: لا يجوز أن يدفع مستخدم iPhone ثمن معلومة لا يعطيها متصفحه.
 *
 * 2. **«دون اتصال» ليست خطأ.** هي وضع تشغيل كامل: ما هو محلي يُقرأ، ولا
 *    يُطلب شيء. عرض خطأ شبكة لمن يقرأ فصلًا منزَّلًا عيب لا إفادة.
 *
 * 3. **اختيار المستخدم فوق كل استنتاج.** `always` و`never` تُحترمان كما هما،
 *    ولا يتفلسف عليهما المحرك.
 */

/** ما يختاره المستخدم. `smart` هو الافتراضي. */
export const PREFETCH_MODES = ['smart', 'wifi', 'always', 'never'];

/**
 * ميزانية التنزيل المسبق.
 *
 * `pages` صفحات تُسخَّن أمام القارئ، و`chapters` فصول كاملة تُجهَّز خلفه،
 * و`metadata` بيانات الفصول الجديدة — وهي وحدها لا تكاد تُذكر في الحجم،
 * ولذلك تبقى مسموحة في كل وضع متصل.
 */
const BUDGETS = {
  /** شبكة غير محدودة ومعروفة. */
  generous: { metadata: true, pages: 4, chapters: 2, images: true },
  /** الوسط: ما يكفي لإخفاء زمن الشبكة أمام القارئ، بلا تجهيز فصول كاملة. */
  measured: { metadata: true, pages: 2, chapters: 0, images: true },
  /** بيانات الجوال أو توفير مفعّل: الضروري فقط. */
  frugal: { metadata: true, pages: 1, chapters: 0, images: true },
  /** دون اتصال: لا شيء يُطلب. المحلي وحده. */
  offline: { metadata: false, pages: 0, chapters: 0, images: false },
};

/**
 * يقرأ حالة الشبكة من المتصفح.
 *
 * كل شيء هنا اختياري بقصد: `navigator` نفسه قد لا يوجد (اختبار)، و`onLine`
 * قد تكذب (متصل بشبكة بلا إنترنت)، و`connection` غائبة على Safari. فالقراءة
 * دفاعية بالكامل، والغياب يعني «لا أعرف» لا «سيئ» ولا «ممتاز».
 */
export function readNetwork(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  if (!nav) return { online: true, kind: 'unknown', saveData: false };

  const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
  const online = nav.onLine !== false;

  if (!connection) return { online, kind: 'unknown', saveData: false };

  const saveData = connection.saveData === true;
  const effective = connection.effectiveType ?? '';
  const type = connection.type ?? '';

  let kind = 'unknown';
  if (type === 'wifi' || type === 'ethernet') kind = 'unmetered';
  else if (type === 'cellular') kind = 'metered';
  // بلا `type` (أغلب المتصفحات): الجيل يفيد كمؤشّر بطء لا كنوع اتصال.
  // ‏2g/3g تعني بطئًا مؤكدًا مهما كان الوسط، فتُعامل كشبكة يجب توفيرها.
  else if (effective === 'slow-2g' || effective === '2g' || effective === '3g') kind = 'metered';

  return { online, kind, saveData };
}

/**
 * يحوّل الوضع المختار وحالة الشبكة إلى ميزانية.
 *
 * دالة نقية: لا تقرأ `navigator` بنفسها، فما تقرّره قابل للاختبار بلا متصفح.
 */
export function prefetchBudget({ mode = 'smart', network = readNetwork() } = {}) {
  if (!network.online) return { ...BUDGETS.offline, reason: 'offline' };
  if (mode === 'never') return { ...BUDGETS.offline, reason: 'user_never' };

  // اختيار المستخدم يسبق كل استنتاج — حتى «وفّر البيانات» في النظام.
  if (mode === 'always') return { ...BUDGETS.generous, reason: 'user_always' };

  if (network.saveData) return { ...BUDGETS.frugal, reason: 'save_data' };

  if (mode === 'wifi') {
    // «Wi-Fi فقط» تعني ما تقوله: شبكة غير محدودة **مؤكَّدة**. والمجهول ليس
    // مؤكَّدًا، فلا يُنزَّل فيه إلا ما يُطلب.
    return network.kind === 'unmetered'
      ? { ...BUDGETS.generous, reason: 'wifi' }
      : { ...BUDGETS.offline, metadata: true, reason: 'wifi_only_not_wifi' };
  }

  // smart
  if (network.kind === 'unmetered') return { ...BUDGETS.generous, reason: 'unmetered' };
  if (network.kind === 'metered') return { ...BUDGETS.frugal, reason: 'metered' };
  // المجهول (Safari/iOS، وأغلب أجهزة سطح المكتب): الوسط المحافظ
  return { ...BUDGETS.measured, reason: 'unknown_network' };
}

/**
 * سياسة حيّة تتبع تغيّر الشبكة.
 *
 * المستخدم يخرج من البيت والفصل يُسخَّن: لو بقيت الميزانية على قيمة الـWi-Fi
 * لأكمل التنزيل على بيانات الجوال. الاستماع للتغيّر ليس رفاهية، هو ما يجعل
 * الوعد بالسياسة صادقًا.
 */
export function createNetworkPolicy({
  mode = 'smart',
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  onChange = null,
} = {}) {
  let current = PREFETCH_MODES.includes(mode) ? mode : 'smart';
  const listeners = new Set();
  if (onChange) listeners.add(onChange);

  const emit = () => {
    const budget = prefetchBudget({ mode: current, network: readNetwork(nav) });
    for (const listener of listeners) {
      try {
        listener(budget);
      } catch {
        // مشترك معطوب لا يوقف البقية
      }
    }
  };

  const target = nav?.connection ?? null;
  const attach = () => {
    if (typeof addEventListener !== 'function') return () => {};
    const handler = () => emit();
    addEventListener('online', handler);
    addEventListener('offline', handler);
    target?.addEventListener?.('change', handler);
    return () => {
      removeEventListener('online', handler);
      removeEventListener('offline', handler);
      target?.removeEventListener?.('change', handler);
    };
  };

  const detach = attach();

  return {
    get mode() {
      return current;
    },
    /** يغيّر الوضع ويُعلن الميزانية الجديدة فورًا. */
    setMode(next) {
      if (!PREFETCH_MODES.includes(next)) return false;
      current = next;
      emit();
      return true;
    },
    /** الميزانية الآن. تُقرأ عند كل قرار تنزيل، لا تُحتجز. */
    budget() {
      return prefetchBudget({ mode: current, network: readNetwork(nav) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: detach,
  };
}
