/**
 * التنبيه الجانبي داخل التطبيق.
 *
 * غير حاجب بقصد: يظهر في زاوية، ولا يأخذ التركيز، ولا يوقف القراءة. الحاجب في
 * منتصف الشاشة أثناء فصل مفتوح أسوأ من لا تنبيه.
 *
 * ولا يوجد أي إشعار من نظام التشغيل: لا FCM، ولا إذن إشعارات، ولا تنبيه
 * والتطبيق مغلق. هذا المسار كله داخل VANTARA وهو مفتوح.
 */

/** أكثر من ثلاثة في وقت واحد يصبح حائطًا لا تنبيهًا. */
const MAX_VISIBLE = 3;
const LIFETIME_MS = 6_000;

let host = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.className = 'toasts';
  // منطقة حيّة مهذّبة: قارئ الشاشة يسمعها بين الفقرات لا يقطع بها
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.append(host);
  return host;
}

/**
 * يعرض تنبيهًا ويرجع دالة إخفائه.
 *
 * `onOpen` اختياري: النقر يفتح المكان الصحيح داخل التطبيق ثم يُخفي التنبيه.
 */
export function showToast({ title, body = '', onOpen = null, lifetimeMs = LIFETIME_MS }) {
  const root = ensureHost();
  while (root.childElementCount >= MAX_VISIBLE) root.firstElementChild?.remove();

  const card = document.createElement(onOpen ? 'button' : 'div');
  card.className = 'toast';
  if (onOpen) card.type = 'button';

  const heading = document.createElement('strong');
  heading.className = 'toast__title';
  heading.textContent = title;
  card.append(heading);

  if (body) {
    const text = document.createElement('span');
    text.className = 'toast__body';
    text.textContent = body;
    card.append(text);
  }

  let timer = null;
  const dismiss = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    card.classList.add('toast--out');
    // الإزالة بعد الانتقال، وبمهلة احتياطية: التبويب المخفي لا يُشغّل
    // `transitionend` فيبقى العنصر إلى الأبد
    const remove = () => card.remove();
    card.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 400);
  };

  if (onOpen) {
    card.addEventListener('click', () => {
      dismiss();
      onOpen();
    });
  }

  root.append(card);
  // إطار واحد قبل الحركة: بلا ذلك يُرسم في موضعه النهائي بلا انتقال
  requestAnimationFrame(() => card.classList.add('toast--in'));
  timer = setTimeout(dismiss, lifetimeMs);
  return dismiss;
}
