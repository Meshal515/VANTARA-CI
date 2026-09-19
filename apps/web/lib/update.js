/**
 * فحص التحديث.
 *
 * المشكلة التي يحلّها: بلا هذا يُرسل الـAPK يدويًا في واتساب مع كل إصدار،
 * وينتهي الأمر بثلاثة أشخاص على ثلاث نسخ مختلفة — وهذا أسوأ ما يصيب المزامنة،
 * لأن نسخة قديمة قد لا تفهم عمليات نسخة جديدة.
 *
 * الملف `version.json` يُنشر مع الواجهة على Pages ويُكتب في إصدار الـAPK.
 * المقارنة على أرقام النسخة لا على نصّها: `1.10.0` أحدث من `1.9.0` نصيًا
 * بالعكس.
 */

import { appVersion, endpoints } from './config.js';

/** مرة كل ست ساعات على الأكثر. فحص كل إقلاع طلب بلا داعٍ. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'vantara.updateCheckedAt';
const DISMISSED_KEY = 'vantara.updateDismissed';

/** `1.10.0` > `1.9.0`: المقارنة رقمية جزءًا جزءًا. */
function isNewer(candidate, current) {
  const a = String(candidate).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * يُعيد `{version, url, notes}` عند توفّر أحدث، أو null.
 *
 * null أيضًا في المتصفح: لا نسخة مبنية هناك، والتحديث يأتي بإعادة التحميل.
 */
export async function checkForUpdate({ force = false } = {}) {
  const current = appVersion();
  const { updates } = endpoints();
  if (!current || !updates) return null;

  if (!force) {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? '0');
    if (Date.now() - last < CHECK_EVERY_MS) return null;
  }

  let payload;
  try {
    const response = await fetch(`${updates}/version.json`, { cache: 'no-store' });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    // بلا شبكة: التحديث ليس عاجلًا ولا يستحق رسالة خطأ
    return null;
  }

  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // تخزين محجوب: يُفحص في كل إقلاع، وهذا مقبول
  }

  const version = String(payload?.version ?? '');
  if (!version || !isNewer(version, current)) return null;
  // نسخة رفضها المستخدم لا تُلاحقه في كل فتح
  if (localStorage.getItem(DISMISSED_KEY) === version) return null;

  return {
    version,
    current,
    url: String(payload?.url ?? ''),
    notes: String(payload?.notes ?? ''),
  };
}

export function dismissUpdate(version) {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // لا شيء: يظهر مرة أخرى في الفتح القادم
  }
}

export { isNewer };
