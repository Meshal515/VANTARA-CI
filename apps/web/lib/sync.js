/**
 * عميل المزامنة.
 *
 * النموذج: الواجهة تقرأ من مرآة محلية دائمًا، والشبكة تحدّث المرآة في
 * الخلفية. لا شاشة تحميل عند كل مزامنة، ولا انتظار لـCloudflare قبل أول رسم.
 *
 * ثلاث قواعد تحمي التجربة:
 *
 * 1. **الـcursor يتقدّم بعد التطبيق لا قبله.** سقوط الشبكة في منتصف الدفعة
 *    يعيد نفس الدفعة، لا يفقدها.
 *
 * 2. **الطابور دائم ومرتّب.** الكتابة تُسجَّل محليًا وتظهر فورًا، ثم تُرسل.
 *    إغلاق التطبيق قبل الإرسال لا يفقدها، وكل عملية تحمل op_id ثابتًا فإعادة
 *    الإرسال لا تُحتسب مرتين.
 *
 * 3. **الإشعار بالتغيير مُصنَّف.** المشتركون يعرفون *ما* تغيّر فيرقّعون العنصر
 *    وحده. إعادة رسم الشاشة كل 25 ثانية تُعيد تحميل الصور وتُرجع التمرير
 *    للأعلى، وهذا وحده كفيل بأن يجعل التطبيق يبدو معطوبًا.
 */

import {
  classifyFailure,
  compactQueue,
  nextAttemptDelay,
  shouldQuarantine,
  syncHealth,
  trimQueue,
} from './queue.js';

const TOKEN_KEY = 'vantara.token';
const USER_KEY = 'vantara.user';
const CURSOR_KEY = 'vantara.cursor';
const QUEUE_KEY = 'vantara.queue';
const MIRROR_KEY = 'vantara.mirror';
const QUARANTINE_KEY = 'vantara.quarantine';
const DEVICE_ID_KEY = 'vantara.device.id';
const DEVICE_CREDENTIAL_KEY = 'vantara.device.credential';

/**
 * سقف الطابور.
 *
 * تجاوزه يعني انقطاعًا طويلًا جدًا. الإسقاط ليس «الأقدم أولًا»: `trimQueue`
 * يضغط أولًا ثم يُسقط أقدم عمليات **الحالة** فقط، ولا يمسّ عملية تراكمية —
 * فصل قُرئ لا يُستعاد، أما موضع قراءة قديم فتصححه أول كتابة قادمة.
 */
const MAX_QUEUE = 500;

/** سقف سجل المعزولات. أبعد من ذلك تشخيصٌ لا يقرأه أحد. */
const MAX_QUARANTINE = 100;

/**
 * سقف جولات السحب في نداء واحد.
 *
 * الخادم يقطع الدفعة عند 500 صفّ لكل جدول، فالمتأخر الكبير يحتاج جولات. والسقف
 * يمنع نداءً واحدًا من الاستمرار إلى الأبد على شبكة بطيئة.
 *
 * لكن الخروج عند السقف **ليس** مزامنة تامّة: تُرفع `backlog` فتقول الحالة
 * الحقيقة، ويُعاد السحب فورًا بدل انتظار الدورة التالية.
 */
const MAX_PULL_ROUNDS = 20;

/** الجداول التي تصل في الفروقات، ومفتاح كل صف. */
const KEYS = {
  accounts: (row) => row.user_id,
  profiles: (row) => row.user_id,
  library: (row) => `${row.user_id}/${row.series_ref}`,
  progress: (row) => `${row.user_id}/${row.chapter_key}`,
  chapter_reads: (row) => `${row.user_id}/${row.chapter_key}`,
  usage_daily: (row) => `${row.user_id}/${row.day}`,
  collections: (row) => `${row.user_id}/${row.kind}/${row.series_ref}`,
  ratings: (row) => `${row.user_id}/${row.series_ref}`,
  comments: (row) => row.id,
  // وصف العمل: عنوانه وغلافه. بلا مفتاح هنا كانت صفوفه تُلقى ويعبر المؤشر
  // فوقها، فتعرض شاشة المكتبة معرّفًا خامًا ولا تعود الصفوف أبدًا.
  works: (row) => row.series_ref,
  reactions: (row) => `${row.comment_id}/${row.user_id}/${row.emoji}`,
  recommendations: (row) => row.id,
  // حالة كل مستلم مستقلة (§19): بلا هذا لا يظهر «منصور قبل · NGM رفض»
  recommendation_recipients: (row) => `${row.recommendation_id}/${row.user_id}`,
  notifications: (row) => row.id,
  activity: (row) => row.id,
  // إيصالات المشاهدة (§13–§15): بلا هذا لا تُعرف من شاهد شيئًا
  activity_receipts: (row) => `${row.event_id}/${row.user_id}`,
  settings: (row) => row.user_id,
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomSecret(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * إثبات الجهاز يُنشأ مرة واحدة ويبقى محليًا. الـWorker يخزّن HMAC فقط.
 */
function deviceProof() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  let deviceCredential = localStorage.getItem(DEVICE_CREDENTIAL_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  if (!deviceCredential) {
    deviceCredential = randomSecret();
    localStorage.setItem(DEVICE_CREDENTIAL_KEY, deviceCredential);
  }
  return { deviceId, deviceCredential };
}

export function createSync({ baseUrl }) {
  const listeners = new Set();
  let token = localStorage.getItem(TOKEN_KEY) ?? null;
  let user = readJson(USER_KEY, null);
  let cursor = Number(localStorage.getItem(CURSOR_KEY) ?? '0') || 0;
  let queue = readJson(QUEUE_KEY, []);
  let mirror = readJson(MIRROR_KEY, {});
  let quarantine = readJson(QUARANTINE_KEY, []);
  let pulling = false;
  let pushing = false;

  /** محاولات متتالية لكل عملية، بمفتاح op_id. لا تُحفظ: العدّ لكل جلسة. */
  const attemptsOf = new Map();
  /** لا نرسل قبل هذا الوقت: تراجع أُسّي بعد فشل مؤقت. */
  let nextPushAt = 0;
  let pushTimer = null;
  /** طلب إرسال وصل أثناء إرسال جارٍ: يُنفَّذ بعده لا يُلغى. */
  let pushAgain = false;
  /**
   * آخر **كتابة** وصلت الخادم.
   *
   * منفصل عن آخر سحب بقصد: السحب ينجح بينما الكتابة معلّقة، فلو خلطناهما لبقيت
   * الصحة تقول «مزامَن» وطابور الكتابة عالق منذ ساعة.
   */
  let lastSuccessAt = Number(localStorage.getItem('vantara.lastPush') ?? '0') || 0;
  let lastSyncAt = Number(localStorage.getItem('vantara.lastSync') ?? '0') || 0;
  // خرج السحب عند سقف الجولات وقد بقي `more`: القراءة ناقصة، والحالة يجب أن
  // تقولها. بلا هذا يعرض الجهاز «مُزامَن» وهو خلف بآلاف الصفوف.
  let backlog = false;
  let lastError = null;
  /** هل نجح آخر حفظ محلي. كتابة لا تُحفظ ليست كتابة دائمة. */
  let durable = true;
  let overflowing = false;

  const emit = (tables) => {
    for (const listener of listeners) {
      try {
        listener(tables);
      } catch {
        // مشترك معطوب لا يوقف البقية
      }
    }
  };

  const persistMirror = () => writeJson(MIRROR_KEY, mirror);

  /**
   * يحفظ الطابور، ويقاتل على المساحة قبل أن يستسلم.
   *
   * `localStorage` يرفض الكتابة عند الامتلاء. تجاهل الرفض — وهو ما كان يحدث —
   * يعني طابورًا يبدو محفوظًا ويضيع عند إغلاق التطبيق. المرآة مشتقة من الخادم
   * وتُسحب من جديد، فهي أول ما يُفرَّغ لإفساح المكان لكتابة لا يملكها غيرنا.
   */
  const persistQueue = () => {
    if (writeJson(QUEUE_KEY, queue)) {
      durable = true;
      return true;
    }
    mirror = {};
    try {
      localStorage.removeItem(MIRROR_KEY);
    } catch {
      // لا شيء نفعله: نحاول الحفظ على أي حال
    }
    durable = writeJson(QUEUE_KEY, queue);
    if (durable) {
      // المرآة فُرِّغت: تُعاد من الخادم، والشاشة تُرقَّع بعدها
      cursor = 0;
      localStorage.setItem(CURSOR_KEY, '0');
      void pull();
    }
    return durable;
  };

  const persistQuarantine = () => writeJson(QUARANTINE_KEY, quarantine);

  /** ينسى عدّ المحاولات لعمليات لم تبقَ في الطابور (ضُغطت أو استقرّت). */
  const pruneAttempts = () => {
    const alive = new Set(queue.map((entry) => entry.opId));
    for (const key of [...attemptsOf.keys()]) if (!alive.has(key)) attemptsOf.delete(key);
  };

  /**
   * يعزل عملية لا أمل في نجاحها.
   *
   * بلا عزل تبقى في رأس الطابور إلى الأبد: كل دورة تحاولها، ولا تنجح، وتُحتسب
   * ككتابة معلّقة فتبدو المزامنة متأخرة دائمًا بلا سبب ظاهر.
   */
  const quarantineOp = (op, status, reason) => {
    quarantine.push({ op, status, reason, at: Date.now() });
    if (quarantine.length > MAX_QUARANTINE) quarantine = quarantine.slice(-MAX_QUARANTINE);
    queue = queue.filter((entry) => entry.opId !== op.opId);
    attemptsOf.delete(op.opId);
    persistQuarantine();
    persistQueue();
  };

  async function sessionPayload(userId) {
    const response = await fetch(`${baseUrl}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, ...deviceProof() }),
    });
    if (!response.ok) {
      const error = new Error(`http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function persistSession(payload) {
    token = payload.token;
    user = payload.user;
    localStorage.setItem(TOKEN_KEY, token);
    writeJson(USER_KEY, user);
  }

  async function refreshSession() {
    if (!user?.userId) {
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }
    try {
      const payload = await sessionPayload(user.userId);
      persistSession(payload);
      emit(['session']);
      return payload;
    } catch (error) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      emit(['session']);
      throw error;
    }
  }

  async function request(path, options = {}, allowRefresh = true) {
    const headers = { ...(options.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 401) {
      if (allowRefresh && user?.userId) {
        try {
          await refreshSession();
          return request(path, options, false);
        } catch {
          // جهاز revoked أو credential مفقود: refreshSession طوى الجلسة.
        }
      } else {
        token = null;
        localStorage.removeItem(TOKEN_KEY);
        emit(['session']);
      }
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`http_${response.status}`);
      error.status = response.status;
      // B10: الخيط إلى سطر السجلّ عند الخادم. يُحمل على الخطأ فيصل إلى
      // `lastError` ومنه إلى البلاغ، بدل أن يبقى البلاغ يقول «ما اشتغل».
      error.correlationId = response.headers.get('x-correlation-id') ?? null;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  // ───────────────────────── الجلسة ─────────────────────────

  async function pairDevice(pairingToken) {
    const response = await fetch(`${baseUrl}/v1/device/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken, ...deviceProof() }),
    });
    if (!response.ok) throw new Error(`pair_${response.status}`);
    return response.json();
  }

  async function consumePairingUrl(value) {
    const url = new URL(value);
    const pairingToken = url.searchParams.get('pair');
    if (!pairingToken) return false;
    await pairDevice(pairingToken);
    return true;
  }

  async function consumePairingFromUrl() {
    if (typeof location === 'undefined') return;
    const url = new URL(location.href);
    if (!url.searchParams.has('pair')) return;

    try {
      await consumePairingUrl(url.href);
    } catch {
      // رمز مستهلك/منتهي لا يعني أن الخادم ساقط. نكمل إلى قائمة الحسابات؛
      // إن كان الجهاز غير موثوق فعلًا فمحاولة الدخول نفسها ستطلب pairing جديدًا.
    } finally {
      // لا نترك ?pair= معطوبًا في العنوان وإلا يعيد كل reload نفس الفشل.
      url.searchParams.delete('pair');
      if (typeof history !== 'undefined') {
        history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      }
    }
  }

  async function attachNativeLinkBridge(appPlugin) {
    if (
      !appPlugin ||
      typeof appPlugin.getLaunchUrl !== 'function' ||
      typeof appPlugin.addListener !== 'function'
    ) {
      return null;
    }

    // سجّل المستمع أولًا كي لا نفقد رابطًا يصل أثناء الإقلاع.
    const listener = await appPlugin.addListener('appUrlOpen', (event) => {
      if (typeof event?.url !== 'string') return;
      void consumePairingUrl(event.url).catch(() => {
        // رابط قديم/منتهي لا يقتل التطبيق. الدخول سيكشف إن كان الجهاز يحتاج pairing جديدًا.
      });
    });

    try {
      const launched = await appPlugin.getLaunchUrl();
      if (typeof launched?.url === 'string') {
        await consumePairingUrl(launched.url);
      }
    } catch {
      // cold-start pairing مساعد للإقلاع، وليس شرطًا لبناء واجهة التطبيق.
    }

    return listener;
  }

  /** قائمة الحسابات للشاشة الأولى. بلا توكن: تُطلب بعد pairing إن وُجد. */
  async function accounts() {
    await consumePairingFromUrl();
    const response = await fetch(`${baseUrl}/v1/accounts`);
    if (!response.ok) throw new Error(`http_${response.status}`);
    return (await response.json()).content ?? [];
  }

  /** اختيار الحساب هو الدخول، وإثبات الجهاز جزء من إصدار الجلسة. */
  async function signIn(userId) {
    const previousId = user?.userId ?? null;
    const payload = await sessionPayload(userId);
    persistSession(payload);
    if (previousId && previousId !== user.userId) resetAll();
    emit(['session']);
    return user;
  }

  function signOut() {
    token = null;
    user = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    resetAll();
    emit(['session']);
  }

  async function logoutDevice() {
    if (token) await request('/v1/device/logout', { method: 'POST' }, false).catch(() => {});
    localStorage.removeItem(DEVICE_CREDENTIAL_KEY);
    signOut();
  }

  async function logoutAll() {
    if (token) await request('/v1/device/logout-all', { method: 'POST' }, false).catch(() => {});
    localStorage.removeItem(DEVICE_CREDENTIAL_KEY);
    signOut();
  }

  /**
   * يعيد بناء المرآة من الصفر بلا لمس الطابور.
   *
   * كان `reset` واحدًا يمسح الطابور أيضًا، ويُنادى عند `reset: true` من الخادم
   * (استعادة D1 من نسخة احتياطية). أي أن استعادةً على الخادم كانت تمسح كتابات
   * المستخدم غير المرسلة — فقدٌ صامت لا علاقة له بسبب الاستعادة.
   */
  function resyncMirror() {
    cursor = 0;
    mirror = {};
    localStorage.setItem(CURSOR_KEY, '0');
    persistMirror();
  }

  /** تبديل حساب أو خروج: كل شيء يُمسح، الطابور معه — ملك الحساب السابق. */
  function resetAll() {
    resyncMirror();
    queue = [];
    quarantine = [];
    attemptsOf.clear();
    nextPushAt = 0;
    overflowing = false;
    persistQueue();
    persistQuarantine();
  }

  // ───────────────────────── السحب ─────────────────────────

  /**
   * يسحب الفروقات ويطبّقها.
   *
   * التطبيق أولًا ثم الـcursor: العكس يفقد دفعة عند سقوط الشبكة. و`more`
   * تعني دفعة مقطوعة عند السقف، فنُكمل فورًا بلا انتظار الدورة القادمة.
   */
  async function pull() {
    if (!token || pulling) return;
    pulling = true;
    try {
      // كل مسارات النداء تستخدم `void pull()`، فرفضٌ بلا معالجة كان يصبح
      // unhandled rejection: لا يظهر للمستخدم، ولا يُسجّل في صحة المزامنة
      for (let round = 0; round < MAX_PULL_ROUNDS; round += 1) {
        const payload = await request(`/v1/sync?since=${cursor}`);
        if (!payload) break;

        if (payload.reset) {
          // عدّاد الخادم رجع (استعادة نسخة احتياطية): نُعيد بناء المرآة، ولا
          // نمسّ الطابور — كتاباتنا غير المرسلة ليست جزءًا مما استُعيد
          resyncMirror();
          continue;
        }

        const touched = [];
        for (const [table, rows] of Object.entries(payload.changes ?? {})) {
          const keyOf = KEYS[table];
          if (!keyOf || !Array.isArray(rows) || rows.length === 0) continue;
          const bucket = (mirror[table] ??= {});
          for (const row of rows) bucket[keyOf(row)] = row;
          touched.push(table);
        }

        persistMirror();
        cursor = Number(payload.cursor ?? cursor) || cursor;
        localStorage.setItem(CURSOR_KEY, String(cursor));
        if (touched.length > 0) emit(touched);
        lastSyncAt = Date.now();
        localStorage.setItem('vantara.lastSync', String(lastSyncAt));
        if (!payload.more) {
          backlog = false;
          break;
        }
        // الجولة الأخيرة وما زال هناك مزيد: نخرج بالسقف، لكن لا نُعلنها
        // مزامنة تامّة، ونعود فورًا بدل انتظار الدورة التالية.
        if (round === MAX_PULL_ROUNDS - 1) {
          backlog = true;
          emit(['sync']);
          setTimeout(() => void pull(), 0);
        }
      }
      lastError = null;
    } catch (error) {
      lastError = { status: error?.status ?? 0, at: Date.now(), correlationId: error?.correlationId ?? null };
      emit(['sync']);
    } finally {
      pulling = false;
    }
  }

  // ───────────────────────── الكتابة ─────────────────────────

  /**
   * يسجّل عملية ويرسلها.
   *
   * الـop_id يُولَّد مرة واحدة هنا ويبقى ثابتًا عبر كل إعادة إرسال — هذا ما
   * يمنع احتساب الفصل مرتين بعد انقطاع.
   */
  function enqueue(kind, payload = {}) {
    const op = { opId: crypto.randomUUID(), kind, payload };
    queue.push(op);
    if (queue.length > MAX_QUEUE) {
      const trimmed = trimQueue(queue, MAX_QUEUE);
      queue = trimmed.ops;
      overflowing = trimmed.overflowing;
      pruneAttempts();
    }
    persistQueue();
    schedulePush();
    return op.opId;
  }

  /**
   * يجمّع الكتابات المتلاحقة في إرسال واحد.
   *
   * التمرير يولّد عمليات تقدم كثيرة متتالية. الإرسال عند كل واحدة كان يُفرغ
   * الطابور عملية بعملية فلا يجد الضغط شيئًا يضغطه: ثلاثة طلبات مكان طلب،
   * وثلاث كتابات عند الخادم مكان أعلاها.
   */
  const ENQUEUE_DEBOUNCE_MS = 400;

  function schedulePush() {
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void push();
    }, ENQUEUE_DEBOUNCE_MS);
  }

  /**
   * يرسل الطابور.
   *
   * `force` يتجاوز التراجع: عودة الاتصال أو ضغط المستخدم على «مزامنة الآن»
   * سببان يستحقان محاولة فورية، بينما الدورة الزمنية تحترم التراجع.
   */
  async function push({ force = false } = {}) {
    if (!token || queue.length === 0) return;
    if (pushing) {
      // طلب أثناء إرسال جارٍ لا يُهمل: الدفعة الحالية قد لا تحمل آخر عملية
      pushAgain = true;
      return;
    }
    if (!force && Date.now() < nextPushAt) return;
    if (!force && typeof navigator !== 'undefined' && navigator.onLine === false) return;

    pushing = true;
    try {
      // لا شيء في الطريق الآن، فالضغط آمن: يقلّص الطلبات بعد انقطاع طويل
      const compacted = compactQueue(queue);
      if (compacted.length !== queue.length) {
        queue = compacted;
        pruneAttempts();
        persistQueue();
      }

      while (queue.length > 0) {
        const batch = queue.slice(0, 100);
        let payload;
        try {
          payload = await request('/v1/ops', { method: 'POST', body: { ops: batch } });
        } catch (error) {
          const status = error?.status ?? 0;
          lastError = { status, at: Date.now(), correlationId: error?.correlationId ?? null };
          const verdict = classifyFailure(status);
          // الجلسة انتهت: الكتابات سليمة وتنتظر جلسة جديدة، فلا عزل ولا تراجع
          if (verdict === 'auth') return;

          for (const op of batch) {
            const attempts = (attemptsOf.get(op.opId) ?? 0) + 1;
            attemptsOf.set(op.opId, attempts);
            if (shouldQuarantine({ attempts, status })) quarantineOp(op, status, verdict);
          }
          const worst = Math.max(...batch.map((op) => attemptsOf.get(op.opId) ?? 1));
          nextPushAt = Date.now() + nextAttemptDelay(worst);
          emit(['sync']);
          return;
        }

        const settled = new Set([...(payload?.applied ?? []), ...(payload?.skipped ?? [])]);
        // استجابة ناجحة لا تذكر عملية تعني أن الخادم رفضها عند التحليل — لا
        // تصلح بإعادة الإرسال. تُعزل حالًا بدل أن تُحاول إلى الأبد.
        for (const op of batch) {
          if (!settled.has(op.opId)) quarantineOp(op, 422, 'not_settled');
        }
        queue = queue.filter((op) => !settled.has(op.opId));
        pruneAttempts();
        persistQueue();

        lastSuccessAt = Date.now();
        localStorage.setItem('vantara.lastPush', String(lastSuccessAt));
        lastError = null;
        nextPushAt = 0;
        overflowing = false;
        if (settled.size === 0) break;
      }
      // الكتابة تُنتج revs جديدة: نسحبها فورًا حتى يرى الجهاز أثر كتابته
      await pull();
      emit(['sync']);
    } finally {
      pushing = false;
      if (pushAgain) {
        pushAgain = false;
        schedulePush();
      }
    }
  }

  /**
   * يعيد المعزولات إلى الطابور.
   *
   * قرار المستخدم لا قرارنا: بعض العزل سببه عطل زائل (نسخة خادم قديمة لا تعرف
   * نوع العملية) وتستحق محاولة ثانية بعد التحديث.
   */
  function retryQuarantined() {
    if (quarantine.length === 0) return 0;
    const revived = quarantine.map((entry) => entry.op).filter(Boolean);
    // الإعادة قد تتجاوز السقف: نفس قاعدة التقليم تُطبَّق، فلا تُسقط الإعادة
    // عملية تراكمية كانت في الطابور
    const trimmed = trimQueue(queue.concat(revived), MAX_QUEUE);
    queue = trimmed.ops;
    overflowing = trimmed.overflowing;
    quarantine = [];
    persistQuarantine();
    persistQueue();
    void push({ force: true });
    return revived.length;
  }

  function health() {
    return syncHealth({
      lastSyncAt,
      backlog,
      pending: queue.length,
      quarantined: quarantine.length,
      lastSuccessAt,
      lastError,
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      durable,
      overflowing,
      now: Date.now(),
    });
  }

  // ───────────────────────── الحضور ─────────────────────────

  async function beat(body) {
    if (!token) return;
    try {
      await request('/v1/presence', { method: 'POST', body });
    } catch {
      // نبضة فائتة لا تستحق خطأً مرئيًا
    }
  }

  async function presence() {
    if (!token) return [];
    try {
      return (await request('/v1/presence'))?.content ?? [];
    } catch {
      return [];
    }
  }

  async function stats(userId) {
    if (!token) return null;
    try {
      return await request(`/v1/stats/${encodeURIComponent(userId)}`);
    } catch {
      return null;
    }
  }

  /**
   * صفوف التقدم التي لم يستلمها مالكها بعد.
   *
   * تُقرأ من الخادم لا من المرآة المحلية: الصندوق قد يحمل ما كتبه جهاز آخر
   * وفشلت كتابته عند المالك، وهذا الجهاز هو من يستطيع تصريفه الآن.
   */
  async function pendingProgress() {
    if (!token) return null;
    return await request('/v1/progress/pending');
  }

  // ───────────────────────── القراءة المحلية ─────────────────────────

  /** صفوف جدول من المرآة، مُرشَّحة اختياريًا. */
  function rows(table, predicate) {
    const bucket = mirror[table];
    if (!bucket) return [];
    const all = Object.values(bucket);
    return predicate ? all.filter(predicate) : all;
  }

  function row(table, key) {
    return mirror[table]?.[key] ?? null;
  }

  /**
   * عودة الاتصال محاولة فورية.
   *
   * الدورة الزمنية كل 15 ثانية مع تراجع أُسّي قد تُبقي كتابة تنتظر دقائق بعد
   * عودة الشبكة فعلًا. حدث `online` يعرف اللحظة بالضبط، فنتجاوز التراجع مرة.
   */
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      nextPushAt = 0;
      void push({ force: true });
      void pull();
    });
    window.addEventListener('offline', () => emit(['sync']));
    // الخروج من التطبيق: آخر فرصة لإرسال ما تراكم قبل أن يُجمَّد التبويب
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void push({ force: true });
    });
  }

  return {
    get user() {
      return user;
    },
    get signedIn() {
      return Boolean(token);
    },
    get authorizationHeader() {
      return token ? `Bearer ${token}` : null;
    },
    get pendingWrites() {
      return queue.length;
    },
    accounts,
    pairDevice,
    consumePairingUrl,
    attachNativeLinkBridge,
    refreshSession,
    signIn,
    signOut,
    logoutDevice,
    logoutAll,
    pull,
    push,
    enqueue,
    beat,
    presence,
    stats,
    pendingProgress,
    health,
    retryQuarantined,
    /**
     * إعادة بناء المرآة من الخادم.
     *
     * مخرج صريح حين تبدو البيانات المحلية غريبة: يمسح المرآة والـcursor ولا
     * يمسّ الطابور. بلا مسار كهذا كان الحل الوحيد تسجيل خروج ودخول — وذلك
     * يمسح كتابات غير مرسلة.
     */
    async resync() {
      resyncMirror();
      emit(['sync']);
      await pull();
    },
    get quarantined() {
      return quarantine.length;
    },
    rows,
    row,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
