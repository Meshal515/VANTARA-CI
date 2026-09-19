/**
 * جدولة العمل الخلفي.
 *
 * المشكلة التي تحلّها هذه الوحدة ليست «هل تنجح العملية» بل «ماذا يحدث للواجهة
 * أثناءها». التطبيق اليوم يطلق كل عمل خلفي فورًا وبالتساوي: تسخين صفحات،
 * وفروقات مكتبة، وحضور، وإشعارات — كلها تتسابق مع إصبع المستخدم على نفس
 * الخيط. والنتيجة تمرير متقطّع بينما كل رقم في الشاشة صحيح.
 *
 * ثلاث قواعد تحكم هذا الملف:
 *
 * 1. **الأولوية تُحترم عند الالتقاط لا عند الإضافة.** مهمة أُضيفت متأخرة
 *    وأولويتها أعلى تسبق ما ينتظر. وإلا صار الترتيب ترتيب وصول لا أهمية.
 *
 * 2. **تفاعل المستخدم يوقف ما دونه.** لمسة أو تمرير ⇒ كل ما هو أدنى من
 *    `PRIORITY.interaction` يتوقف عن الالتقاط لفترة قصيرة. الجدولة التي لا
 *    تتنازل ليست جدولة، هي طابور.
 *
 * 3. **المهمة تُلغى ولا تُترك تكمل.** الخروج من عمل ودخول آخر يعني أن نتائج
 *    الأول لم تعد مطلوبة: تُلغى شبكتها ويُرفض ناتجها المتأخر.
 */

/** سلّم الأولويات كما أقرّه العقد. الأصغر أهم. */
export const PRIORITY = {
  /** تفاعل مباشر: لا يمرّ من هنا أصلًا، لكنه المرجع الذي يُقاس عليه. */
  interaction: 0,
  /** الفصل/الصفحة التي ينظر إليها المستخدم الآن. */
  current: 1,
  /** الصفحات المجاورة. */
  near: 2,
  /** فروقات المكتبة والحالة. */
  delta: 3,
  /** تسخين فصول لم تُطلب بعد. */
  prefetch: 4,
  /** صيانة: تنظيف، إحصاءات، ما لا يراه أحد. */
  maintenance: 5,
};

/**
 * مدة تنازل العمل الخلفي بعد تفاعل المستخدم.
 *
 * مقاسة على السلوك لا مخترعة: التمرير بالقصور الذاتي على الجوال يستمر مئات
 * المللي ثانية بعد رفع الإصبع، واستئناف العمل داخلها يُسقِط إطارات في نهاية
 * الحركة — وهي أكثر لحظة يلاحظها المستخدم.
 */
const YIELD_AFTER_INTERACTION_MS = 400;

/**
 * سقف زمن الدفعة الواحدة قبل التنازل للمتصفح.
 *
 * ‏50 مل ث هو الحدّ المعروف لما يبقى محسوسًا كاستجابة فورية؛ أطول منه يبدأ
 * المستخدم يشعر أن اللمسة «تأخرت».
 */
const SLICE_MS = 50;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** تنازل للمتصفح: نافذة خمول إن وُجدت، وإلا مهلة قصيرة. */
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      // السقف مهم: بلا `timeout` قد لا تأتي نافذة خمول أبدًا على شاشة نشطة،
      // فتتجمّد المهام الخلفية إلى الأبد بدل أن تتأخر.
      requestIdleCallback(() => resolve(), { timeout: 200 });
      return;
    }
    // Safari/iOS بلا requestIdleCallback: مهلة صفرية تعطي المتصفح فرصة رسم
    setTimeout(resolve, 0);
  });
}

/**
 * ينشئ مجدولًا.
 *
 * `runner` قابل للحقن للاختبار وحده؛ الإنتاج يستخدم الافتراضي.
 */
export function createScheduler({ yieldFn = yieldToBrowser, clock = now } = {}) {
  /** طوابير لكل أولوية: الالتقاط يمشي من الأهم إلى الأدنى. */
  const lanes = new Map();
  let draining = false;
  let quietUntil = 0;

  const laneFor = (priority) => {
    if (!lanes.has(priority)) lanes.set(priority, []);
    return lanes.get(priority);
  };

  /** أهم مهمة منتظرة الآن، مع احترام التنازل بعد التفاعل. */
  const takeNext = () => {
    const quiet = clock() < quietUntil;
    const priorities = [...lanes.keys()].sort((a, b) => a - b);
    for (const priority of priorities) {
      // أثناء التنازل لا يُلتقط إلا ما هو بأهمية الصفحة الحالية أو أعلى:
      // الصفحة التي يقرأها المستخدم الآن جزء من تفاعله، لا عمل خلفي.
      if (quiet && priority > PRIORITY.current) continue;
      const lane = lanes.get(priority);
      if (lane && lane.length > 0) return lane.shift();
    }
    return null;
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const entry = takeNext();
        if (!entry) {
          // لا شيء قابل للالتقاط: إمّا فرغ الطابور، أو الكل متنازل الآن.
          // في الحالة الثانية ننتظر انقضاء التنازل بدل أن نُنهي التصريف.
          const waiting = [...lanes.values()].some((lane) => lane.length > 0);
          if (!waiting) break;
          await yieldFn();
          continue;
        }

        if (entry.signal?.aborted) {
          entry.reject(abortError());
          continue;
        }

        const startedAt = clock();
        try {
          entry.resolve(await entry.run({ signal: entry.signal }));
        } catch (error) {
          entry.reject(error);
        }

        // دفعة طويلة ⇒ تنازل قبل التالية. بلا هذا تصير عشر مهام قصيرة
        // كتلة واحدة طويلة على الخيط الرئيسي.
        if (clock() - startedAt >= SLICE_MS) await yieldFn();
      }
    } finally {
      draining = false;
    }
  };

  return {
    /**
     * يضيف مهمة ويعيد وعدها.
     *
     * الرفض عند الإلغاء متعمَّد: المُنادي يجب أن يفرّق بين «فشلت» و«لم تعد
     * مطلوبة»، وإرجاع `undefined` بهدوء يخلط الحالتين.
     */
    run(runFn, { priority = PRIORITY.delta, signal = null } = {}) {
      return new Promise((resolve, reject) => {
        laneFor(priority).push({ run: runFn, priority, signal, resolve, reject });
        // التصريف يُؤجَّل إلى microtask بقصد: الشاشة تضيف عدة مهام في نفس
        // اللحظة (صفحة حالية، وجوار، وفروقات). لو بدأ الالتقاط مع أول إضافة
        // لالتُقطت هي — فتصير الأولوية ترتيب وصول لا أهمية.
        void Promise.resolve().then(drain);
      });
    },

    /**
     * يُعلن تفاعلًا: العمل الخلفي يتنازل لفترة قصيرة.
     *
     * يُنادى من مسارات اللمس والتمرير، وهي كثيرة التكرار — فالدالة رخيصة
     * عمدًا: إسناد رقم، لا أكثر.
     */
    noteInteraction() {
      quietUntil = clock() + YIELD_AFTER_INTERACTION_MS;
    },

    /** كم مهمة تنتظر. للتشخيص والاختبار. */
    get pending() {
      let count = 0;
      for (const lane of lanes.values()) count += lane.length;
      return count;
    },

    /** هل العمل الخلفي متنازل الآن. */
    get yielding() {
      return clock() < quietUntil;
    },
  };
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * يمنع تكرار الطلب لنفس المورد أثناء الطيران.
 *
 * ثلاثة أجزاء من التطبيق قد تطلب `chapter-84/page-01` في نفس اللحظة: القارئ،
 * والتسخين، والصفحة التالية. بلا هذا تذهب ثلاثة طلبات لنفس البايتات — على
 * بيانات الجوال هذا ثمن يدفعه المستخدم بلا مقابل.
 *
 * الفشل **لا يُخزَّن**: طلب فشل لانقطاع لحظي يجب أن يُعاد، لا أن يُعاد فشله
 * المحفوظ لكل من يسأل بعده.
 */
export function createInFlight() {
  const inFlight = new Map();

  return {
    run(key, factory) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      const promise = (async () => factory())().finally(() => {
        inFlight.delete(key);
      });

      inFlight.set(key, promise);
      return promise;
    },

    get size() {
      return inFlight.size;
    },
  };
}

/**
 * أجيال: ما بدأ قبل التبديل لا يُطبَّق بعده.
 *
 * `AbortController` يوقف الشبكة، لكنه لا يمنع نتيجة وصلت **قبل** الإلغاء من
 * أن تُرسم على شاشة تبدّلت. المستخدم خرج من عمل ودخل آخر، فتصل نتيجة الأول
 * وتكتب فوق الثاني — وهذا يبدو كخلل عشوائي لا كخطأ برمجي.
 */
export function createGenerations() {
  let generation = 0;
  let controller = null;

  return {
    /** يبدأ جيلًا جديدًا ويُلغي ما قبله. يعيد ما يلزم للتحقق لاحقًا. */
    next() {
      generation += 1;
      controller?.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      const mine = generation;
      return {
        id: mine,
        signal: controller?.signal ?? null,
        /** هل ما زال هذا الجيل هو الحالي؟ يُسأل قبل لمس الشاشة. */
        current: () => mine === generation,
      };
    },

    /** إلغاء بلا بدء جيل جديد: مغادرة الشاشة كليًا. */
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },

    get id() {
      return generation;
    },
  };
}
