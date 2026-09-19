/**
 * شاشة اختيار الحساب.
 *
 * اختيار الحساب **هو** تسجيل الدخول. لا كلمة مرور، ولا PIN، ولا معرّف يُكتب،
 * ولا خطوة تحقق. VANTARA تطبيق خاص بين ثلاثة، والاحتكاك هنا لا يشتري أمانًا
 * يُذكر — يشتري تأخيرًا في كل فتح.
 *
 *   فتح التطبيق → شريط الحسابات → لمسة → داخل.
 *
 * حساب واحد في المنتصف بوضوح، والسحب ينقل للتالي بلا أول ولا آخر. الخلفية
 * تتبع الحساب الذي في المنتصف، فالشاشة تتغير معك لا بعدك.
 *
 * القفل و«متصل الآن» إعلام لا حاجز: لا شيء يُفحص، والدخول يبقى لمسة.
 */

import { createCoverflow } from '../lib/coverflow.js';
import { createGradient } from '../lib/gradient.js';
import { cachedPalette, paletteFor, paletteFromName } from '../lib/colors.js';
import { icon } from '../lib/icons.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** «قبل 32 دقيقة» بلا مكتبة تواريخ. */
function agoLabel(timestamp) {
  if (!timestamp) return 'لم يدخل بعد';
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return 'قبل لحظات';
  if (minutes < 60) return `آخر ظهور قبل ${minutes} دقيقة`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `آخر ظهور قبل ${hours} ساعة`;
  return `آخر ظهور قبل ${Math.floor(hours / 24)} يوم`;
}

function statusLine(account) {
  if (account.status === 'READING') return 'يقرأ الآن';
  if (account.status === 'ONLINE') return 'متصل الآن';
  if (account.status === 'IDLE') return 'خامل';
  return agoLabel(account.lastSeenAt);
}

/**
 * لوحة الحساب.
 *
 * بصورة: تُستخرج منها. بلا صورة: مشتقة من الاسم — ثلاثة حسابات بلا صور تعني
 * ثلاث خلفيات متطابقة، فيضيع الإحساس بأن الخلفية تتبع الحساب.
 */
function paletteSource(account) {
  return account.avatarKey ? cachedPalette(account.avatarKey) : paletteFromName(account.displayName);
}

async function resolvePalette(account) {
  if (!account.avatarKey) return paletteFromName(account.displayName);
  return paletteFor(account.avatarKey);
}

export async function screenAccounts({ sync, mount, onSignedIn }) {
  const wrap = el('main', 'gate');

  const backdrop = el('div', 'gate__backdrop');
  wrap.append(backdrop);

  const inner = el('section', 'gate__inner');

  const brand = el('header', 'gate__brand');
  const mark = el('img', 'gate__mark');
  mark.src = '/icons/icon-512.png';
  mark.alt = '';
  mark.width = 64;
  mark.height = 64;
  brand.append(mark, el('h1', 'gate__word', 'VANTARA'));
  brand.append(el('p', 'gate__tag', 'عالم واحد .. لكل القصص'));
  inner.append(brand);

  const flowHost = el('div', 'gate__flow');
  inner.append(flowHost);

  const caption = el('div', 'gate__caption');
  const name = el('h2', 'gate__name', '');
  const status = el('p', 'gate__status', '');
  caption.append(name, status);
  inner.append(caption);

  const enter = el('button', 'gate__enter');
  enter.type = 'button';
  enter.append(el('span', null, 'دخول'));
  inner.append(enter);

  const message = el('p', 'gate__message');
  inner.append(message);

  wrap.append(inner);
  mount(wrap);

  // ───────────────────────── الحسابات ─────────────────────────

  let accounts = [];
  try {
    accounts = await sync.accounts();
  } catch {
    message.className = 'gate__message gate__message--error';
    message.textContent = 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال.';
    return () => {};
  }

  if (accounts.length === 0) {
    message.textContent = 'لا توجد حسابات.';
    return () => {};
  }

  const gradient = createGradient(backdrop, paletteSource(accounts[0]));

  const renderCard = (account) => {
    const card = el('div', 'acc');

    const face = el('div', 'acc__face');
    if (account.avatarKey) {
      const image = el('img', 'acc__avatar');
      image.src = account.avatarKey;
      image.alt = '';
      image.decoding = 'async';
      face.append(image);
    } else {
      // بديل مُولَّد: الحرف الأول على لوحة الحساب. أهدأ من صورة عامة مكررة.
      const palette = paletteSource(account);
      const initial = el('div', 'acc__initial', [...String(account.displayName)][0] ?? '؟');
      initial.style.background = `linear-gradient(150deg, ${palette.primary}, ${palette.secondary})`;
      initial.style.color = palette.accent;
      face.append(initial);
    }

    // القفل: أحد جالس في هذا الحساب الآن. إعلام لا منع.
    if (account.active) {
      const lock = el('div', 'acc__lock');
      lock.append(icon('lock', 14));
      face.append(lock);
      face.append(el('span', 'acc__live'));
    }

    card.append(face);
    return card;
  };

  let current = accounts[0];

  const flow = createCoverflow(flowHost, {
    items: accounts,
    renderCard,
    onChange: (_index, account) => {
      current = account;
      name.textContent = account.displayName;
      status.textContent = statusLine(account);
      status.classList.toggle('gate__status--live', account.active);
      // الفوري من الكاش حتى لا تتأخر الخلفية عن الإصبع، ثم المُستخرج
      gradient.setPalette(paletteSource(account));
      void resolvePalette(account).then((palette) => {
        if (current === account) gradient.setPalette(palette);
      });
    },
    onActivate: () => void signIn(),
  });

  // ───────────────────────── الدخول ─────────────────────────

  let busy = false;
  async function signIn() {
    if (busy || !current) return;
    busy = true;
    enter.disabled = true;
    message.className = 'gate__message';
    message.textContent = '';
    try {
      const user = await sync.signIn(current.userId);
      await onSignedIn(user);
    } catch {
      message.className = 'gate__message gate__message--error';
      message.textContent = 'تعذّر الدخول. حاول مرة أخرى.';
      enter.disabled = false;
      busy = false;
    }
  }

  enter.addEventListener('click', () => void signIn());

  return () => {
    flow.destroy();
    gradient.destroy();
  };
}
