/**
 * قواعد الإشعارات عند العميل.
 *
 * الصندوق يستلم دائمًا؛ هذا الملف يقرر **المنبثق** وحده: ما يظهر كتنبيه جانبي
 * صغير الآن. الحالة الثلاثية (`created/seen/read`) تعيش في D1 ومالكها الخادم،
 * وهنا نقرأها لا نخترعها.
 *
 * أسماء الأنواع مكرّرة عن `packages/domain/src/notifications.ts` لأن الواجهة
 * JS خالص بلا bundler فلا تستورد الحزمة. اختبار في
 * `tools/repository-safety.test.mjs` يفشل إذا اختلفت القائمتان، فالتكرار
 * مكشوف لا صامت.
 */

/** نص كل نوع كما يُقرأ في التنبيه والإعدادات. */
export const NOTIFICATION_LABELS = {
  RECOMMENDATION: 'التوصيات',
  COMMENT_REPLY: 'الردود والتعليقات',
  REACTION: 'التفاعلات',
  FRIEND_ACTIVITY: 'نشاط الأصدقاء',
  SYSTEM: 'أحداث مهمة',
};

export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_LABELS);

/** حالة الصف. `read` تعني العرض ضمنًا حتى لو لم يُكتب `seen`. */
export function stateOf(row) {
  if (row?.read === 1 || row?.read === true) return 'read';
  if (row?.seen === 1 || row?.seen === true) return 'seen';
  return 'created';
}

/** غير المقروء: `read` هو المعيار وحده — العرض ليس قراءة. */
export function unreadCount(rows) {
  return rows.filter((row) => stateOf(row) !== 'read').length;
}

/**
 * إعدادات المنبثق من الإعدادات المشتركة.
 *
 * التسامح مقصود: حقل فاسد أو ناقص يعني «مفعّل». الافتراض المعاكس كان سيُسكت كل
 * التنبيهات بسبب إعداد مكتوب خطأ، وهو عطل لا يشتكي منه المستخدم بل يظنّ أن
 * أصدقاءه لا يرسلون شيئًا.
 */
export function popupSettings(settingsRow) {
  let data = {};
  try {
    const raw = settingsRow?.data;
    data = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  } catch {
    data = {};
  }
  const block = data?.notifications ?? {};
  const kinds = {};
  for (const kind of NOTIFICATION_KINDS) {
    kinds[kind] = block?.kinds?.[kind] !== false;
  }
  return { enabled: block?.popups !== false, kinds };
}

/** ما يُكتب في الإعدادات عند تغيير مفتاح. شكل واحد لا اثنان. */
export function popupPatch(settings) {
  const kinds = {};
  for (const kind of NOTIFICATION_KINDS) kinds[kind] = settings.kinds[kind] !== false;
  return { notifications: { popups: settings.enabled !== false, kinds } };
}

/**
 * هل يظهر تنبيه جانبي لهذا الصف الآن؟
 *
 * أربعة شروط: الإشعار لي، ولستُ الفاعل، ولم يُعرض بعد، والنوع غير مُطفأ.
 * الشرط الثالث هو ما يمنع تكرار نفس التنبيه عند كل مزامنة.
 */
export function shouldToast(row, { viewerId, settings }) {
  if (!row || !viewerId) return false;
  if (row.user_id !== viewerId) return false;
  if (row.actor_id && row.actor_id === viewerId) return false;
  if (stateOf(row) !== 'created') return false;
  if (settings.enabled === false) return false;
  if (!NOTIFICATION_KINDS.includes(row.kind)) return true;
  return settings.kinds[row.kind] !== false;
}

/** الصفوف التي تستحق تنبيهًا، الأقدم أولًا كي يظهر الترتيب طبيعيًا. */
export function toastable(rows, context) {
  return rows
    .filter((row) => shouldToast(row, context))
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}
