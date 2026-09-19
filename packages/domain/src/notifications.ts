/**
 * الإشعارات داخل التطبيق — وداخله فقط.
 *
 * لا Firebase ولا FCM ولا إذن إشعارات من نظام التشغيل ولا تنبيه والجوال مغلق.
 * الإشعار يُنشأ في D1 عند حدوثه، ويصل الجهاز عبر سجل الفروقات نفسه، ويظهر
 * كتنبيه جانبي صغير إن كان VANTARA مفتوحًا.
 *
 * ثلاث قواعد حاكمة:
 *
 * 1. **الصندوق دائم والمنبثق عابر.** تعطيل المنبثق لا يمنع وصول الإشعار: من
 *    أطفأ التنبيهات يريد ألا يُقطع عليه، لا أن يخسر توصية صديقه. لذلك الحالة
 *    ثلاثية — `created` وصل، `seen` عُرض أو فُتح الصندوق، `read` فتحه المستخدم
 *    — وقرار المنبثق يقرأ الحالة ولا يغيّر وصول الإشعار.
 *
 * 2. **التقدّم في الحالة أحادي الاتجاه.** جهاز متأخر يزامن `seen` بعد أن قرأ
 *    الآخر الإشعار يجب ألا يُرجعه غير مقروء. القاعدة رتبة لا قيمة تُكتب فوق
 *    أخرى.
 *
 * 3. **الفاعل لا يُشعر نفسه.** توصية «للجميع» تذهب لكل الحسابات إلا صاحبها،
 *    وتفاعل على تعليقك منك أنت ليس خبرًا.
 */

/**
 * الأنواع القابلة للتحكم.
 *
 * قائمة مغلقة بقصد: نوع لا يعرفه العميل لا يستطيع المستخدم إطفاءه، فيصبح
 * إشعارًا لا مهرب منه.
 */
export const NOTIFICATION_KINDS = [
  'RECOMMENDATION',
  'COMMENT_REPLY',
  'REACTION',
  'FRIEND_ACTIVITY',
  'SYSTEM',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** ترتيب الحالات. الرقم رتبة لا قيمة: `read` لا يرجع إلى `seen`. */
const STATE_RANK = { created: 0, seen: 1, read: 2 } as const;

export type NotificationState = keyof typeof STATE_RANK;

export interface NotificationRow {
  /** 1 إذا عُرض التنبيه أو فُتح الصندوق. */
  seen?: number | boolean | null;
  /** 1 إذا فتح المستخدم الإشعار نفسه. */
  read?: number | boolean | null;
}

function flag(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true;
}

/** حالة الصف كما تُقرأ من D1. */
export function stateOf(row: NotificationRow): NotificationState {
  if (flag(row.read)) return 'read';
  if (flag(row.seen)) return 'seen';
  return 'created';
}

/**
 * الحالة بعد حدث.
 *
 * لا تنزل أبدًا: مزامنة متأخرة من جهاز آخر لا تجعل المقروء غير مقروء.
 */
export function advanceState(current: NotificationState, next: NotificationState): NotificationState {
  return STATE_RANK[next] > STATE_RANK[current] ? next : current;
}

/** غير المقروء: `read` هو المعيار، لا `seen` — العرض ليس قراءة. */
export function unreadCount(rows: readonly NotificationRow[]): number {
  return rows.reduce((total, row) => (flag(row.read) ? total : total + 1), 0);
}

// ───────────────────────── إعدادات المنبثق ─────────────────────────

export interface PopupSettings {
  /** المفتاح العام. إطفاؤه لا يمسّ الصندوق. */
  enabled: boolean;
  /** إطفاء نوع بعينه. الأنواع غير المذكورة مفعّلة. */
  kinds: Readonly<Partial<Record<NotificationKind, boolean>>>;
}

export const DEFAULT_POPUP_SETTINGS: PopupSettings = { enabled: true, kinds: {} };

/**
 * يقرأ إعدادات المنبثق من مخزن الإعدادات المشتركة.
 *
 * التسامح مقصود: إعداد فاسد أو ناقص يعني «مفعّل». الافتراض المعاكس كان سيُسكت
 * كل التنبيهات بسبب حقل مكتوب خطأ، وهو عطل لا يشتكي منه المستخدم بل يظنّ أن
 * أصدقاءه لا يرسلون شيئًا.
 */
export function popupSettingsFrom(data: unknown): PopupSettings {
  const source = (data ?? {}) as Record<string, unknown>;
  const raw = (source['notifications'] ?? {}) as Record<string, unknown>;
  const kinds: Partial<Record<NotificationKind, boolean>> = {};
  const rawKinds = (raw['kinds'] ?? {}) as Record<string, unknown>;
  for (const kind of NOTIFICATION_KINDS) {
    if (rawKinds[kind] === false) kinds[kind] = false;
  }
  return { enabled: raw['popups'] !== false, kinds };
}

/** هل يُسمح بمنبثق لهذا النوع؟ (الصندوق يستلم دائمًا.) */
export function popupAllowed(kind: string, settings: PopupSettings): boolean {
  if (!settings.enabled) return false;
  if (!isNotificationKind(kind)) return true;
  return settings.kinds[kind] !== false;
}

/**
 * قرار إظهار التنبيه الجانبي.
 *
 * أربعة شروط: النوع مسموح، والإشعار لم يُعرض بعد، ولستُ أنا الفاعل، والإشعار
 * لي. الشرط الثاني هو ما يمنع إعادة عرض نفس التنبيه عند كل مزامنة.
 */
export function shouldToast(input: {
  kind: string;
  state: NotificationState;
  actorId?: string | null;
  userId: string;
  viewerId: string;
  settings: PopupSettings;
}): boolean {
  if (input.userId !== input.viewerId) return false;
  if (input.actorId && input.actorId === input.viewerId) return false;
  if (input.state !== 'created') return false;
  return popupAllowed(input.kind, input.settings);
}

// ───────────────────────── الإنتاج ─────────────────────────

/**
 * مستلمو إشعار واحد.
 *
 * `to` فارغ يعني «للجميع». كان الـWorker يُنشئ إشعارًا للمستلم المحدد فقط،
 * فتوصية للجميع لا تُشعر أحدًا: تظهر في سجل التوصيات ولا يعرف بها أحد.
 *
 * المعرّفات مرتبة ومنزوعة التكرار كي يكون `op_id` المشتق لكل مستلم ثابتًا بين
 * المحاولات — وإلا أنتجت إعادة الإرسال إشعارًا ثانيًا لنفس الحدث.
 */
export function notificationTargets(input: {
  accounts: readonly string[];
  actorId: string;
  to?: string | null;
}): string[] {
  const actor = input.actorId;
  if (input.to) return input.to === actor ? [] : [input.to];
  return [...new Set(input.accounts)].filter((id) => id !== actor).sort();
}

/** معرّف الإشعار المشتق من العملية ومستلمها: ثابت، فإعادة التسليم لا تُكرّر. */
export function notificationId(opId: string, userId: string): string {
  return `${opId}:${userId}`;
}
