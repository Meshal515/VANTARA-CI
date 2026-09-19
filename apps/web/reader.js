/**
 * القارئ.
 *
 * المشكلة التي تحلّها هذه الوحدة: على الجوال، السحب للتمرير والنقر للتحكم
 * يبدآن بنفس الحدث. قارئ يعامل كل `touchend` كنقرة يفتح الشريط في وجهك مع كل
 * تمرير، وقارئ يعامل كل لمسة كتمرير لا يستجيب للنقر أصلًا.
 *
 * التمييز هنا بثلاثة شروط معًا: مسافة قصيرة، ومدة قصيرة، وعدم وجود تمرير
 * بينهما. وأي واحد يسقط ⇒ ليست نقرة.
 *
 * والشريط لا يغطي: عند ظهوره يُزاح المحتوى بـpadding بدل أن يُرسم فوقه.
 */

// إبهام يتحرك أقل من هذا = نقرة. أكثر = تمرير. مقاسة على شاشة جوال، لا مخترعة:
// ‏10px أقل من ارتجاف الإصبع الطبيعي، و14 يبدأ يبتلع تمريرًا قصيرًا مقصودًا.
const TAP_SLOP_PX = 12;
// اللمسة الأطول من هذا نية أخرى: ضغط مطوّل، أو تمرير بدأ ببطء.
const TAP_MAX_MS = 320;
// بعد التمرير، تُتجاهل النقرات لهذه المدة: رفع الإصبع بعد تمرير بالقصور الذاتي
// ليس نقرة.
const SCROLL_COOLDOWN_MS = 180;

export function createTapDetector({ onTap }) {
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let moved = false;
  let tracking = false;
  let lastScrollAt = 0;

  const markScrolled = () => {
    lastScrollAt = performance.now();
  };

  const onTouchStart = (event) => {
    // لمستان أو أكثر = تكبير، لا نقرة ولا تمرير
    if (event.touches.length !== 1) {
      tracking = false;
      return;
    }
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startedAt = performance.now();
    moved = false;
    tracking = true;
  };

  const onTouchMove = (event) => {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (
      Math.abs(touch.clientX - startX) > TAP_SLOP_PX ||
      Math.abs(touch.clientY - startY) > TAP_SLOP_PX
    ) {
      moved = true;
    }
  };

  const onTouchEnd = (event) => {
    if (!tracking) return;
    tracking = false;

    if (moved) return;
    if (performance.now() - startedAt > TAP_MAX_MS) return;
    if (performance.now() - lastScrollAt < SCROLL_COOLDOWN_MS) return;

    const touch = event.changedTouches[0];
    onTap({ x: touch?.clientX ?? startX, y: touch?.clientY ?? startY, source: 'touch' });
  };

  const onTouchCancel = () => {
    tracking = false;
  };

  // الماوس مسار منفصل: لا سحب ولا قصور ذاتي، والنقرة نقرة.
  const onClick = (event) => {
    // النقرة المصطنعة بعد اللمس تحمل detail=0 في بعض المتصفحات
    if (event.detail === 0) return;
    onTap({ x: event.clientX, y: event.clientY, source: 'mouse' });
  };

  return {
    attach(element, scrollElement = window) {
      // passive: المتصفح لا ينتظر منّا قرارًا، فيبقى التمرير بستين إطارًا
      element.addEventListener('touchstart', onTouchStart, { passive: true });
      element.addEventListener('touchmove', onTouchMove, { passive: true });
      element.addEventListener('touchend', onTouchEnd, { passive: true });
      element.addEventListener('touchcancel', onTouchCancel, { passive: true });
      element.addEventListener('click', onClick);
      scrollElement.addEventListener('scroll', markScrolled, { passive: true });

      return () => {
        element.removeEventListener('touchstart', onTouchStart);
        element.removeEventListener('touchmove', onTouchMove);
        element.removeEventListener('touchend', onTouchEnd);
        element.removeEventListener('touchcancel', onTouchCancel);
        element.removeEventListener('click', onClick);
        scrollElement.removeEventListener('scroll', markScrolled);
      };
    },
  };
}

/**
 * منطقة النقرة: الثلث العلوي والسفلي للتنقل، والوسط للشريط.
 *
 * في واجهة عربية، يمين الشاشة هو "السابق". لكن في الويبتون العمودي التنقل
 * رأسي، فالتقسيم رأسي أيضًا ولا يتأثر بالاتجاه.
 */
export function zoneOf(y, height) {
  if (y < height * 0.28) return 'prev';
  if (y > height * 0.72) return 'next';
  return 'chrome';
}

/**
 * يحمّل الصفحات مع تحميل مسبق محدود.
 *
 * الحد مقصود: تحميل فصل كامل مسبقًا يخنق اتصالًا منزليًا ويستهلك بيانات
 * الجوال بلا داعٍ. صفحتان أمام القارئ تكفيان لإخفاء زمن الشبكة.
 */
export function createPageLoader({
  bookId,
  pageNumbers,
  prefetch = 2,
  maxWidth,
  baseUrl = '',
  fetchImpl = fetch,
  /** ترويسة الهوية عند الإرسال. دالة لا قيمة: التوكن عمره خمس عشرة دقيقة. */
  authorization = null,
}) {
  // الترقيم 1-based: الفهرس 0 يرجع 502 من upstream، وهذا خطأ صامت لولا القياس
  //
  // baseUrl مطلق داخل الـAPK: لا أصل مشترك هناك، فالمسار النسبي يشير إلى
  // الحاوية المحلية لا إلى خادم المحتوى. فارغ في المتصفح، وهو الصحيح هناك.
  const query = maxWidth ? `?maxWidth=${maxWidth}` : '';

  /** مسار الكوكي: يعمل في المتصفح (أصل مشترك)، ولا يعمل على الـAPK. */
  const cookieUrlFor = (pageNumber) =>
    `${baseUrl}/v1/img/page/${encodeURIComponent(bookId)}/${pageNumber}${query}`;

  /** page → رابط موقَّع، أو `null` حتى يُوقَّع (أو إن تعذّر التوقيع). */
  let signed = null;
  let expiresAt = 0;
  let minting = null;

  // هامش قبل الانتهاء: رابط يبقى ثانية واحدة لا يكفي لصورة تبدأ الآن
  const RENEW_MARGIN_MS = 30_000;
  // سقف الخادم للتوقيع في نداء واحد (`MAX_PAGES_PER_MINT`)
  const MINT_CHUNK = 300;
  const fresh = () => signed !== null && Date.now() < expiresAt - RENEW_MARGIN_MS;

  /**
   * يوقّع روابط صفحات الفصل.
   *
   * نداء واحد للفصل كله لا نداء لكل صفحة: ثلاثون صفحة تعني ثلاثين توقيعًا،
   * وهي نفس الجلسة ونفس اللحظة.
   *
   * وفشله ليس فشل القارئ: نسقط إلى مسار الكوكي. هذا يعمل في المتصفح، ولا يعمل
   * على الـAPK — والفرق ظاهر في السجل لا مخفيًّا في صورة مكسورة.
   */
  const mint = async () => {
    if (minting) return minting;
    minting = (async () => {
      try {
        const map = new Map();
        let nearest = Infinity;

        // الخادم يرفض فصلًا أطول من سقفه في نداء واحد. الرفض يعني السقوط إلى
        // مسار الكوكي — وهو لا يعمل على الـAPK، أي فصلًا مكسورًا لعملٍ فصوله
        // طويلة. فيُجزَّأ الطلب بدل أن يُرفض.
        for (let at = 0; at < pageNumbers.length; at += MINT_CHUNK) {
          const chunk = pageNumbers.slice(at, at + MINT_CHUNK);
          // التوقيع نداء JSON بجلسة: على الـAPK لا كوكي عبر الأصول، فالهوية
          // في الترويسة. بلا هذا كان التوقيع نفسه يرجع 401 — أي أن إصلاح
          // الصور يفشل عند بابه.
          const identity = authorization?.() ?? null;
          const response = await fetchImpl(`${baseUrl}/v1/media/pages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(identity ? { authorization: identity } : {}),
            },
            body: JSON.stringify({ bookId, pages: chunk }),
            credentials: baseUrl ? 'include' : 'same-origin',
          });
          if (!response?.ok) return false;
          const body = await response.json();
          for (const entry of body?.content ?? []) map.set(entry.page, entry.url);
          nearest = Math.min(nearest, Number(body?.expiresAt ?? 0));
        }

        if (map.size === 0 || !Number.isFinite(nearest)) return false;
        signed = map;
        expiresAt = nearest;
        return true;
      } catch {
        return false;
      } finally {
        minting = null;
      }
    })();
    return minting;
  };

  const urlFor = (pageNumber) => {
    if (fresh()) {
      const path = signed.get(pageNumber);
      if (path) return `${baseUrl}${path}`;
    }
    return cookieUrlFor(pageNumber);
  };

  const warmed = new Set();

  return {
    urlFor,
    /** هل الروابط موقَّعة الآن؟ يجيب عن «لماذا فشلت الصورة» بلا تخمين. */
    get signing() {
      return fresh();
    },
    /** يوقّع قبل بناء الصفحات. لا يرمي: القارئ يُفتح على كل حال. */
    prepare: mint,
    /**
     * يجدّد التوقيع ويقول إن تغيّر شيء.
     *
     * يلزم لأن الصور تُحمَّل بـ`lazy`: فصل طويل يُقرأ ببطء يصل إلى صفحاته
     * الأخيرة بعد انتهاء الروابط، فترجع 401 وتظهر مكسورة رغم أن الجلسة سليمة.
     */
    async renew() {
      if (fresh()) return true;
      signed = null;
      return mint();
    },
    /** يسخّن الصفحات التالية بلا أن يحجب أي شيء. */
    warmAfter(pageNumber) {
      const at = pageNumbers.indexOf(pageNumber);
      if (at < 0) return;
      for (let i = at + 1; i <= at + prefetch && i < pageNumbers.length; i++) {
        const next = pageNumbers[i];
        if (warmed.has(next)) continue;
        warmed.add(next);
        const image = new Image();
        image.decoding = 'async';
        image.src = urlFor(next);
      }
    },
  };
}

/**
 * يتابع الصفحة الظاهرة ويُبلّغ عند تغيّرها.
 *
 * IntersectionObserver لا setState على كل حدث تمرير: الثاني يعيد الرسم عشرات
 * المرات في الثانية ويُسقط الإطارات، وهو السبب الأول لقارئ "غير سلس".
 */
export function observePages({ container, onPageChange, threshold = 0.5 }) {
  let current = -1;

  const observer = new IntersectionObserver(
    (entries) => {
      // الأكثر ظهورًا هو الصفحة الحالية، لا آخر ما دخل الشاشة
      let best = null;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (best === null || entry.intersectionRatio > best.intersectionRatio) best = entry;
      }
      if (!best) return;

      const index = Number(best.target.dataset.page);
      if (Number.isNaN(index) || index === current) return;
      current = index;
      onPageChange(index);
    },
    { root: null, threshold: [threshold] },
  );

  return {
    watch(element) {
      observer.observe(element);
    },
    disconnect() {
      observer.disconnect();
    },
    get current() {
      return current;
    },
  };
}

/**
 * يحفظ التقدم بلا أن يُغرق الشبكة.
 *
 * التمرير يولّد تغييرات كثيرة؛ الحفظ عند كل واحدة يرسل مئات الطلبات لفصل
 * واحد. هذا يؤجّل، ويتجاهل الصفحة المتكررة، ويحفظ حتمًا عند إخفاء الصفحة
 * (‏`visibilitychange` هو آخر حدث نضمنه على الجوال، لا `beforeunload`).
 */
export function createProgressSaver({
  bookId,
  delayMs = 2_000,
  fetchImpl = fetch,
  baseUrl = '',
  /** يُنادى بالصفحة فقط بعد أن يقبلها مالك التقدم فعلًا. */
  onSaved = null,
  /** ترويسة الهوية عند الإرسال. دالة لا قيمة: التوكن قصير العمر. */
  authorization = null,
}) {
  let timer = null;
  let pending = null;
  let lastSaved = null;

  const send = async (page, useBeacon = false) => {
    if (page === lastSaved) return;
    lastSaved = page;
    const body = JSON.stringify({ page });
    const url = `${baseUrl}/v1/books/${encodeURIComponent(bookId)}/progress`;

    if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // beacon ينجو من إغلاق التبويب، بخلاف fetch. لا جواب منه، فلا إقرار:
      // الصف يبقى في الصندوق ويُصرَّف عند الإقلاع القادم.
      //
      // ولا ترويسة معه — الـAPI لا يسمح بذلك. فعلى الـAPK قد يرجع 401 بلا أن
      // نعلم، ولذلك بقاء الصف في الصندوق ليس تفصيلًا: هو ما يجعل هذه الحالة
      // خسارة مؤجّلة لا خسارة نهائية.
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    try {
      const identity = authorization?.() ?? null;
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(identity ? { authorization: identity } : {}),
        },
        body,
        keepalive: true,
        // الاعتماد يجب أن يُرسل صراحةً عبر الأصول: `fetch` الافتراضي
        // `same-origin`، وهذا المسار يتجاوز عميل الـAPI المشترك. فعلى الـAPK
        // (`https://localhost` → خادم آخر) كان يذهب بلا اعتماد فيرجع 401 —
        // وحفظ التقدم لا ينجح أبدًا بلا خطأ ظاهر للقارئ.
        credentials: baseUrl ? 'include' : 'same-origin',
      });
      // fetch لا يرمي على 401/502. اعتبار ذلك نجاحًا كان يعلّم التقدم «وصل
      // المالك» وهو لم يصل، فيضيع بلا إعادة محاولة ويعود القارئ للصفحة الأولى.
      if (!response?.ok) {
        lastSaved = null;
        return;
      }
      onSaved?.(page);
    } catch {
      // فقدان حفظ تقدم ليس سببًا لإزعاج القارئ؛ النبضة التالية تصلحه
      lastSaved = null;
    }
  };

  return {
    update(page) {
      pending = page;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (pending !== null) void send(pending);
      }, delayMs);
    },
    flush(useBeacon = false) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null) void send(pending, useBeacon);
    },
  };
}
