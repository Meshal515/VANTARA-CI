/**
 * شريط الحسابات الدائري.
 *
 * الآلية من مرجع 21st.dev: موضع كسري واحد هو مصدر الحقيقة، والرسم يذهب إلى
 * الـDOM مباشرة لا عبر إعادة بناء — ستون تحديث حالة في الثانية يعيد بناء كل
 * بطاقة لأرقام لا تحتاج أن تُرى. الدوران بلا نسخ: الفرق يُطوى إلى أقصر طريق
 * حول الحلقة، فلا أول ولا آخر.
 *
 * ما عُدِّل لـVANTARA:
 *
 *   - **ثلاث بطاقات لا اثنتا عشرة.** حجب الحافة في المرجع مُعاير على عدد
 *     كبير: عند ثلاثة يجعل الجارين بنصف شفافية دائمًا. هنا يخبو على نصف
 *     خطوة قبل نقطة الانتقال وحدها.
 *   - **المنتصف مهيمن.** الحساب المختار أكبر ومستوٍ، والجاران مائلان
 *     وأصغر: الشاشة تسأل «من أنت» فيجب أن يكون الجواب واحدًا واضحًا.
 *   - بناء محتوى البطاقة يأتي من المُستدعي، فلا نصوص عرض هنا.
 */

/** ميل الجار الأول بالدرجات. */
const ROTATE = 42;
/** كم يتراجع الجار للخلف، كنسبة من عرض البطاقة. */
const DEPTH = 0.55;
/** بُعد الناظر كمضاعف لعرض البطاقة. الأصغر عدسة أوسع. */
const PERSPECTIVE = 3.1;
/** أُس المسافة. تحت 1 يخفّ الميل تدريجيًا بدل أن يُغلق الجار. */
const FALLOFF = 0.58;
/** ما يُفقد من الشفافية لكل خطوة. */
const FADE = 0.16;
/** ما يُفقد من الحجم لكل خطوة: المنتصف يبقى الأكبر. */
const SHRINK = 0.16;
/**
 * المسافة بين البطاقات كنسبة من العرض.
 *
 * ضيقة بقصد: الجاران يلامسان بطاقة المنتصف تقريبًا، فتُقرأ الثلاثة كشريط
 * واحد. الفجوة الواسعة تجعلها ثلاث بطاقات منفصلة تصادف أن تكون بجوار بعضها.
 */
const GAP = 0.05;

/**
 * @param {HTMLElement} host
 * @param {{
 *   items: unknown[],
 *   renderCard: (item: unknown, index: number) => HTMLElement,
 *   onChange?: (index: number, item: unknown) => void,
 *   onActivate?: (index: number, item: unknown) => void,
 * }} options
 */
export function createCoverflow(host, { items, renderCard, onChange, onActivate }) {
  const count = items.length;
  if (count === 0) return { destroy() {}, goTo() {}, get index() { return 0; } };

  const frame = document.createElement('div');
  frame.className = 'flow__frame';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'listbox');
  frame.setAttribute('aria-label', 'اختر حسابك');

  const track = document.createElement('div');
  track.className = 'flow__track';
  frame.append(track);
  host.append(frame);

  const cards = items.map((item, index) => {
    const card = document.createElement('div');
    card.className = 'flow__card';
    card.setAttribute('role', 'option');
    card.append(renderCard(item, index));
    track.append(card);
    return card;
  });

  /** الموضع الكسري في المنتصف. مصدر الحقيقة الوحيد. */
  let pos = 0;
  /** إلى أين تتجه التسوية الحالية. الخطو من `pos` يُسقط لمسة تصل أثناء الحركة. */
  let target = 0;
  let width = 0;
  let raf = null;
  let selected = 0;
  let drag = null;

  const indexAt = (value) => ((Math.round(value) % count) + count) % count;

  const paint = () => {
    if (!width) return;
    const pitch = width * (1 + GAP);

    cards.forEach((card, index) => {
      // طيّ المسافة إلى أقصر طريق حول الحلقة: هذه هي آلية الدوران كلها،
      // بلا نسخ عقد ولا إعادة ترتيب للـDOM
      let offset = ((index - pos) % count + count) % count;
      if (offset > count / 2) offset -= count;

      const distance = Math.abs(offset);
      const ramp = distance ** FALLOFF;
      // مسقوف قبل الحرف: بطاقة بعيدة لا تُدير ظهرها
      const tilt = Math.min(ROTATE * ramp, 74) * Math.sign(offset);
      const scale = Math.max(0.6, 1 - SHRINK * distance);

      card.style.transform =
        `translateX(calc(-50% + ${offset * pitch}px)) ` +
        `translateZ(${-DEPTH * width * ramp}px) ` +
        `rotateY(${-tilt}deg) scale(${scale})`;

      // البطاقة تُنقل إلى الجهة الأخرى عند نصف دورة بالضبط، فيجب أن تكون قد
      // اختفت. يخبو على نصف خطوة قبل ذلك لا على المسافة كلها — وهذا ما يجعل
      // ثلاث بطاقات تعمل كما تعمل اثنتا عشرة.
      const toEdge = count / 2 - distance;
      const edge = Math.min(1, Math.max(0, toEdge / 0.5));
      card.style.opacity = String(Math.max(0, 1 - FADE * distance) * edge);
      card.style.zIndex = String(100 - Math.round(distance * 10));
      card.classList.toggle('flow__card--center', distance < 0.5);
      card.setAttribute('aria-selected', distance < 0.5 ? 'true' : 'false');
    });
  };

  const announce = (index) => {
    if (index === selected) return;
    selected = index;
    onChange?.(index, items[index]);
  };

  const settle = (to) => {
    if (raf !== null) cancelAnimationFrame(raf);
    target = to;
    announce(indexAt(to));

    const step = () => {
      const remaining = target - pos;
      if (Math.abs(remaining) < 0.0004) {
        pos = target;
        paint();
        raf = null;
        return;
      }
      // خفوت أُسّي لا نابض: النابض يتجاوز الهدف ويرتد، وهذا يجعل اختيار
      // الحساب يبدو غير حاسم
      pos += remaining * 0.16;
      paint();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const nudge = (by) => settle(Math.round(target) + by);

  const goTo = (index) => {
    // أقصر طريق، لا فكّ الحلقة كلها
    settle(index + Math.round((target - index) / count) * count);
  };

  const onPointerDown = (event) => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    frame.setPointerCapture(event.pointerId);
    target = pos;
    drag = { id: event.pointerId, x: event.clientX, pos, v: 0, t: performance.now(), moved: 0 };
  };

  const onPointerMove = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const pitch = width * (1 + GAP);
    if (!pitch) return;
    const now = performance.now();
    const previous = pos;
    const dx = event.clientX - drag.x;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    pos = drag.pos - dx / pitch;
    // بطاقات في الثانية، للرمية
    drag.v = ((pos - previous) / Math.max(now - drag.t, 1)) * 1000;
    drag.t = now;
    announce(indexAt(pos));
    paint();
  };

  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const wasDrag = drag.moved > 6;
    const carried = Math.max(-2, Math.min(2, drag.v * 0.18));
    const from = drag;
    drag = null;
    settle(Math.round(pos + carried));
    // لمسة بلا سحب على بطاقة المنتصف = دخول
    if (!wasDrag && from) {
      const index = indexAt(pos);
      if (event.target instanceof Element && event.target.closest('.flow__card--center')) {
        onActivate?.(index, items[index]);
      }
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      nudge(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      nudge(1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate?.(selected, items[selected]);
    }
  };

  frame.addEventListener('pointerdown', onPointerDown);
  frame.addEventListener('pointermove', onPointerMove);
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
  frame.addEventListener('keydown', onKeyDown);

  frame.style.perspective = `calc(var(--flow-card) * ${PERSPECTIVE})`;

  // عرض البطاقة يحدد الخطوة والعمق والمنظور، فهو الشيء الوحيد الذي يُقاس
  const measure = () => {
    const first = cards[0];
    if (!first) return;
    width = first.offsetWidth;
    paint();
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(frame);

  onChange?.(0, items[0]);

  return {
    goTo,
    nudge,
    get index() {
      return selected;
    },
    destroy() {
      if (raf !== null) cancelAnimationFrame(raf);
      observer.disconnect();
      frame.remove();
    },
  };
}
