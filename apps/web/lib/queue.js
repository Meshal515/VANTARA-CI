/**
 * قواعد طابور الكتابة غير المتصل.
 *
 * الطابور هو الجزء الذي إذا أخطأ لا يظهر كخطأ، بل كفصل قرأه المستخدم ولم
 * يُحتسب، أو ساعة قراءة ضاعت، أو تقدم رجع للخلف. لذلك كل قاعدة هنا دالة نقية
 * مُختبرة، ولا يحتوي `sync.js` منطق قرار — يستدعي هذه ولا يعيد كتابتها.
 *
 * أربع قواعد حاكمة:
 *
 * 1. **التصنيف قبل أي إسقاط.** العملية إما استبدال حالة (آخر قيمة تكفي)، أو
 *    تراكمية (+1 أو +ms، إسقاطها فقدٌ نهائي)، أو حدث بهوية (تعليق، توصية).
 *    الطابور الممتلئ كان يُسقط الأقدم، والأقدم هو تمامًا ما لا يُستعاد.
 *
 * 2. **الضغط يحفظ الأثر لا آخر نية.** ضغط `progress.set` بآخر قيمة يفقد تقدمًا:
 *    من قرأ حتى 30 ثم رجع إلى 12 يجب أن يصل الخادم 30، لأن الخادم يدمج بـMAX.
 *    لذلك لكل نوع حالة دالة دمج، والافتراضي «الأحدث يفوز».
 *
 * 3. **الفشل ليس نوعًا واحدًا.** 4xx (غير 408/429) عطل دائم في العملية نفسها:
 *    إعادتها إلى الأبد تُبقيها في الطابور بلا أمل. 5xx وانقطاع الشبكة مؤقتان
 *    ويستحقان تراجعًا أُسيًّا لا محاولة كل 15 ثانية.
 *
 * 4. **الصحة مرئية.** الكتابة المعلّقة التي لا تصل يجب أن تُقال للمستخدم، لا
 *    أن تُبلع في `catch {}`. التطبيق الذي يبدو سليمًا وكتاباته معلّقة أسوأ من
 *    التطبيق الذي يقول «لم تُزامن».
 */

/** استبدال حالة: آخر قيمة (أو دمجها) تكفي، وإعادة الإرسال بلا أثر إضافي. */
const STATE = 'state';
/** تراكمية: تضيف إلى قيمة قائمة. لا تُدمج ولا تُسقط أبدًا. */
const CUMULATIVE = 'cumulative';
/** حدث بهوية ثابتة: يُدرج مرة، وتكراره يصطدم بالمفتاح. */
const EVENT = 'event';

export const OP_CLASS = { STATE, CUMULATIVE, EVENT };

/**
 * أعلى قيمة تفوز.
 *
 * الخادم يدمج التقدم بـMAX؛ فلو ضغطنا الطابور بآخر عملية لأصبح «رجعت إلى
 * الصفحة 12» هو كل ما يعرفه، وضاعت الـ30 التي وصلها القارئ فعلًا.
 */
function mergeProgressOps(older, newer) {
  return {
    ...newer,
    payload: {
      ...newer.payload,
      page: Math.max(Number(older.payload?.page ?? 0), Number(newer.payload?.page ?? 0)),
      ratio: Math.max(Number(older.payload?.ratio ?? 0), Number(newer.payload?.ratio ?? 0)),
    },
  };
}

/**
 * جدول العمليات.
 *
 * `key` يحدد هوية الهدف الذي تستبدله العملية. عمليتان بنفس المفتاح تُضغطان،
 * وعمليتان بمفتاحين مختلفين لا تُمسّان. `merge` اختياري، وبلا `key` لا ضغط.
 */
const OPS = {
  'progress.set': { class: STATE, key: (p) => `progress/${p.chapterKey}`, merge: mergeProgressOps },
  'progress.confirm': { class: STATE, key: (p) => `confirm/${p.chapterKey}`, merge: mergeProgressOps },
  'library.add': { class: STATE, key: (p) => `library/${p.seriesRef}` },
  'library.remove': { class: STATE, key: (p) => `library/${p.seriesRef}` },
  'favorite.set': { class: STATE, key: (p) => `favorite/${p.seriesRef}` },
  'readLater.set': { class: STATE, key: (p) => `readLater/${p.seriesRef}` },
  'rating.set': { class: STATE, key: (p) => `rating/${p.seriesRef}` },
  'notification.read': { class: STATE, key: (p) => `notification/${p.id}` },
  'reaction.set': { class: STATE, key: (p) => `reaction/${p.commentId}/${p.emoji}` },
  // الترقيع على مستوى الحقل: ضغط رقعتين بحقلين مختلفين يفقد إحداهما، فالمفتاح
  // يحمل أسماء الحقول — رقعتان لنفس الحقول فقط تُضغطان
  'profile.patch': { class: STATE, key: (p) => `profile/${Object.keys(p.fields ?? {}).sort().join(',')}` },
  'settings.patch': { class: STATE, key: (p) => `settings/${Object.keys(p.fields ?? {}).sort().join(',')}` },
  'chapter.complete': { class: CUMULATIVE },
  'usage.add': { class: CUMULATIVE },
  'comment.add': { class: EVENT },
  'recommendation.send': { class: EVENT },
  'activity.add': { class: EVENT },
};

/**
 * تصنيف نوع غير معروف.
 *
 * `CUMULATIVE` هو الافتراض الآمن: نوع جديد لم يُسجَّل هنا لن يُضغط ولن يُسقط.
 * الافتراض بأنه حالة كان سيسمح بإسقاط شيء لا نعرف أنه يُستعاد.
 */
export function classifyOp(kind) {
  return OPS[kind]?.class ?? CUMULATIVE;
}

/** مفتاح الضغط، أو `null` لما لا يُضغط. */
export function stateKeyOf(op) {
  const spec = OPS[op?.kind];
  if (!spec || spec.class !== STATE || !spec.key) return null;
  try {
    return spec.key(op.payload ?? {});
  } catch {
    return null;
  }
}

/**
 * يضغط الطابور بلا فقد أثر.
 *
 * العمليات التراكمية والأحداث تمرّ كما هي. عمليات الحالة تُدمج في واحدة لكل
 * مفتاح، **في موضع آخر ظهور للمفتاح** كي لا تتقدّم كتابة على كتابة أُرسلت
 * بعدها منطقيًا.
 */
export function compactQueue(ops) {
  const merged = new Map();
  for (const op of ops) {
    const key = stateKeyOf(op);
    if (key === null) continue;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, op);
      continue;
    }
    const spec = OPS[op.kind];
    merged.set(key, spec?.merge ? spec.merge(previous, op) : op);
  }

  const emitted = new Set();
  const out = [];
  // المرور من الآخر للأول: العملية المدموجة تأخذ موضع آخر ظهور
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    const key = stateKeyOf(op);
    if (key === null) {
      out.push(op);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(merged.get(key));
  }
  return out.reverse();
}

/**
 * يُنزل الطابور إلى الحد المسموح.
 *
 * الضغط أولًا. إن بقي أطول من الحد، يُسقط **الأقدم من عمليات الحالة فقط**:
 * فقدها يعني قيمة أقدم يصححها أول كتابة قادمة، بينما فقد عملية تراكمية يعني
 * فصلًا قرأه المستخدم ولا يُحتسب أبدًا. إن كان الطابور كله تراكميًا/أحداثًا
 * فلا إسقاط: يتجاوز الحد ويُعلَّم `overflowing` لتقوله الصحة.
 */
export function trimQueue(ops, limit) {
  const compacted = compactQueue(ops);
  if (compacted.length <= limit) {
    return { ops: compacted, dropped: 0, overflowing: false };
  }

  const excess = compacted.length - limit;
  const droppable = [];
  for (let i = 0; i < compacted.length && droppable.length < excess; i += 1) {
    if (classifyOp(compacted[i].kind) === STATE) droppable.push(i);
  }
  const drop = new Set(droppable);
  const kept = compacted.filter((_, index) => !drop.has(index));
  return { ops: kept, dropped: drop.size, overflowing: kept.length > limit };
}

// ───────────────────────── الفشل وإعادة المحاولة ─────────────────────────

/** أول تراجع، ثم يتضاعف. */
export const RETRY_BASE_MS = 5_000;
/** سقف التراجع: خمس دقائق تكفي لعطل خادم بلا أن تبدو الكتابة منسية. */
export const RETRY_MAX_MS = 300_000;
/** بعد هذا العدد من المحاولات المتتالية تُعزل العملية. */
export const MAX_ATTEMPTS = 8;

/**
 * تصنيف الفشل.
 *
 * `permanent` للأخطاء التي لا تتغير بإعادة الإرسال: 400 (عملية فاسدة)، 413
 * (دفعة أكبر من الحد). 408/429 وكل 5xx مؤقتة. `0` يعني انقطاع شبكة.
 */
export function classifyFailure(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retry';
}

/** تراجع أُسّي مع نثر عشوائي: ثلاثة أجهزة تعود معًا تضرب الخادم معًا. */
export function nextAttemptDelay(attempt, random = Math.random) {
  const exponential = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, RETRY_MAX_MS);
  // نثر ±20% حول القيمة
  const jitter = capped * 0.2 * (random() * 2 - 1);
  return Math.max(1_000, Math.round(capped + jitter));
}

/** هل تُعزل هذه العملية الآن؟ */
export function shouldQuarantine({ attempts, status }) {
  if (classifyFailure(status) === 'permanent') return true;
  return attempts >= MAX_ATTEMPTS;
}

// ───────────────────────── صحة المزامنة ─────────────────────────

/** بعد هذا الصمت مع كتابات معلّقة، المزامنة عالقة لا بطيئة. */
export const STUCK_AFTER_MS = 600_000;

/**
 * حالة المزامنة كما تُعرض.
 *
 * الترتيب مقصود: عدم الديمومة أخطر من العزل، والعزل أخطر من التأخر. الأسوأ
 * يظهر أولًا، لأن رسالة واحدة هي كل ما يراه المستخدم.
 */
export function syncHealth({
  pending = 0,
  quarantined = 0,
  /** آخر كتابة وصلت الخادم. */
  lastSuccessAt = 0,
  /** آخر سحب ناجح. نجاحه لا يعني أن الكتابة وصلت. */
  lastSyncAt = 0,
  /** خرج السحب وقد بقي `more`: القراءة ناقصة وإن كانت الكتابة كلها وصلت. */
  backlog = false,
  lastError = null,
  online = true,
  durable = true,
  overflowing = false,
  now = Date.now(),
}) {
  const base = { pending, quarantined, lastError, lastSuccessAt, lastSyncAt, backlog };

  if (!durable) {
    return { ...base, state: 'degraded', message: 'تعذّر حفظ الكتابات على الجهاز' };
  }
  if (quarantined > 0) {
    return { ...base, state: 'blocked', message: `${quarantined} عملية معزولة تحتاج مراجعة` };
  }
  if (overflowing) {
    return { ...base, state: 'blocked', message: 'الطابور ممتلئ ولا يمكن إسقاط شيء بأمان' };
  }
  if (!online) {
    return { ...base, state: 'offline', message: pending > 0 ? `${pending} كتابة تنتظر الاتصال` : 'بلا اتصال' };
  }
  if (pending > 0 && lastSuccessAt > 0 && now - lastSuccessAt > STUCK_AFTER_MS) {
    return { ...base, state: 'stuck', message: 'الكتابات لم تصل منذ مدة' };
  }
  if (pending > 0) {
    return { ...base, state: 'syncing', message: `${pending} كتابة قيد الإرسال` };
  }
  // كل الكتابات وصلت، لكن القراءة لم تُستنزف بعد. «مُزامَن» هنا كذبة:
  // الجهاز يعرف أن عنده متأخّرًا ولا يقوله.
  if (backlog) {
    return { ...base, state: 'syncing', message: 'يجلب ما فاتك' };
  }
  return { ...base, state: 'ok', message: 'مُزامَن' };
}
