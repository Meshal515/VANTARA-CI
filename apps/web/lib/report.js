/**
 * بلاغ مشكلة من الجهاز.
 *
 * الخادم يملك المسار والتنقية أصلًا (`POST /v1/reports`): ينقّي بقائمة
 * محظورات ثم **يرفض الكتابة** إن بقي فيها سرّ. هذه الوحدة النصف الناقص، ولا
 * تُعيد بناء تلك القاعدة — تلعب دورًا آخر:
 *
 * الخادم يحمي من سرٍّ **أُرسل**. وهذه الوحدة تمنع إرساله من أصله: قائمة
 * **سماح** لا منع. لا يُجمع إلا ما هو مسمّى هنا، فكائن حالة أوسع — أو حقل
 * يُضاف غدًا — لا يركب مع البلاغ بالخطأ. والطبقتان معًا: لا نجمع ما لا نحتاج،
 * ولا نكتب ما نشكّ فيه.
 *
 * ومن هذا: لا روابط بمعاملات. رابط الصفحة عندنا موقَّع (`?t=<hmac>`) ويفتحها
 * بلا جلسة، والمسار وحده هو ما يفيد التشخيص.
 */

/** أنواع البلاغات كما يقبلها الخادم. نوعٌ غيرها يرجع 400 بعد رحلة كاملة. */
export const REPORT_KINDS = [
  'CHAPTER_WONT_OPEN',
  'MISSING_PAGE',
  'WRONG_ORDER',
  'WRONG_CHAPTER',
  'BAD_TRANSLATION',
  'DUPLICATE_WORK',
  'WRONG_CHAPTER_NUMBER',
  'LOW_QUALITY',
  'OTHER',
];

/** التسمية العربية لكل نوع. الرمز للخادم والتسمية للمستخدم. */
export const REPORT_KIND_LABELS = {
  CHAPTER_WONT_OPEN: 'الفصل لا يفتح',
  MISSING_PAGE: 'صفحة ناقصة',
  WRONG_ORDER: 'ترتيب الصفحات خطأ',
  WRONG_CHAPTER: 'الفصل خطأ',
  BAD_TRANSLATION: 'ترجمة سيئة',
  DUPLICATE_WORK: 'العمل مكرر',
  WRONG_CHAPTER_NUMBER: 'رقم الفصل خطأ',
  LOW_QUALITY: 'جودة الصور ضعيفة',
  OTHER: 'شيء ثاني',
};

/** المسار بلا معاملات: التوقيع لا يفيد التشخيص، وإرساله يفيد من يسرقه. */
function pathOnly(value) {
  if (typeof value !== 'string' || value === '') return null;
  const cut = value.split(/[?#]/)[0];
  return cut === '' ? null : cut;
}

function text(value, max = 200) {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, max);
}

function count(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

/**
 * صورة الحالة التي تُرفق بالبلاغ.
 *
 * كل حقل هنا مقصود، والبقية تُترك. وما لم يُعطَ يبقى `null` — لا قيمة
 * مُختلقة: تشخيصٌ يكذب أسوأ من لا تشخيص.
 */
export function clientSnapshot(context = {}) {
  const health = context.health ?? {};
  return {
    appVersion: text(context.appVersion, 40),
    screen: text(context.screen, 40),
    // حالة المزامنة وأعدادها: تكفي لمعرفة هل المشكلة في الشبكة أو في المحتوى
    syncState: text(health.state, 20),
    pending: count(health.pending),
    quarantined: count(health.quarantined),
    // الرقم وحده. كائن الخطأ يحمل رسالةً وأثرًا لا نعرف ما فيهما
    lastErrorStatus: count(context.lastError?.status),
    online: typeof context.online === 'boolean' ? context.online : null,
    viewport: text(context.viewport, 20),
    // أصل الـAPI يفيد في معرفة أي نشرٍ يتكلم عنه البلاغ. بلا معاملات
    endpoint: pathOnly(context.endpoint),
    lastImage: pathOnly(context.lastImage),
  };
}

/**
 * يرسل البلاغ.
 *
 * `api` هو نفس ناقل الـContent API، فالجلسة والتجديد يمرّان من مكان واحد.
 */
export async function submitReport({
  api,
  kind,
  seriesRef,
  chapterRef,
  pageIndex,
  sourceId,
  description,
  context = {},
}) {
  if (!REPORT_KINDS.includes(kind)) {
    const error = new Error('unknown_kind');
    error.code = 'unknown_kind';
    throw error;
  }

  // الحقول الاختيارية تُحذف ولا تُرسل `null`: مخطَّط الخادم يقبل الغياب
  // ويرفض `null` في حقل نصّي، فبلاغٌ كامل كان يرجع 400 بسبب حقل فارغ.
  const body = { kind, client: clientSnapshot(context) };
  const series = text(seriesRef, 200);
  if (series) body.seriesRef = series;
  const chapter = text(chapterRef, 200);
  if (chapter) body.chapterRef = chapter;
  const source = text(sourceId, 200);
  if (source) body.sourceId = source;
  const note = text(description, 2000);
  if (note) body.description = note;
  if (Number.isInteger(pageIndex) && pageIndex >= 0) body.pageIndex = pageIndex;
  // B10: معرّف النداء الذي فشل عند المستخدم. بلا هذا يبقى البلاغ يقول
  // «ما اشتغل» ويبقى السجلّ يحمل مئة سطر في تلك الدقيقة، والربط تخمين.
  const correlationId = text(context.correlationId ?? context.lastError?.correlationId, 64);
  if (correlationId) body.correlationId = correlationId;

  return api('/v1/reports', { method: 'POST', body });
}
