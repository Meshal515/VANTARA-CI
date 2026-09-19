/**
 * قواعد المزامنة.
 *
 * ثلاثة هواتف تتزامن عبر Cloudflare Worker + D1. أي خلل هنا لا يظهر كخطأ، بل
 * كتقدم قراءة يرجع للخلف أو فصل يُحتسب مرتين — ولهذا كل قاعدة هنا دالة نقية
 * مُختبرة، ومصدرها الوحيد هذا الملف: الـWorker يستوردها ولا يعيد كتابتها.
 *
 * أربع قواعد حاكمة:
 *
 * 1. **الترتيب بـrev لا بالوقت.** ساعات الهواتف الثلاثة لا تتفق، وصفّان في
 *    نفس المللي ثانية يجعلان `updated_since` يفقد أحدهما. لذلك لكل تعديل رقم
 *    من عدّاد تصاعدي واحد في D1، والعميل يطلب `rev > cursor`.
 *
 * 2. **الكتابة معرّفة بـop_id.** الشبكة تسقط بعد أن يطبّق الخادم وقبل أن تصل
 *    الإجابة، فالعميل يعيد المحاولة. بلا op_id تُحتسب القراءة مرتين ويُرسل
 *    الترشيح مرتين. المعرّف يجعل إعادة المحاولة بلا أثر.
 *
 * 3. **التقدم لا يرجع.** جهاز قديم يزامن صفحة 12 بعد أن قرأ الآخر 30 يجب أن
 *    يُدمج بـmax لا بآخر كتابة. LWW هنا يفقد 18 صفحة فعلية.
 *
 * 4. **الحضور خارج سجل الفروقات.** نبضة كل 25 ثانية × 3 مستخدمين ترفع العدّاد
 *    بلا توقف، فيبقى كل عميل يسحب فروقات إلى الأبد. الحضور له مسار منفصل
 *    بعُمر محدد، ولا يلمس rev.
 */

import { MAX_BEAT_CREDIT_MS } from './presence.ts';

/** نسخة البروتوكول. العميل يرسلها، والخادم يرفض ما لا يعرفه. */
export const SYNC_PROTOCOL = 1;

/**
 * أقصى ما تحمله عملية وقت استخدام واحدة.
 *
 * العميل يجمّع النبضات محليًا ويرسلها دفعة عند الاتصال، فالسقف هنا أوسع من
 * سقف النبضة الواحدة — لكنه موجود: بلا سقف يستطيع عميل معطوب أن يكتب 40 ساعة
 * في عملية واحدة ويفسد الإحصائيات بلا طريقة لاكتشاف ذلك.
 */
export const MAX_USAGE_OP_MS = 15 * 60_000;

/** الفصل لا يُحتسب مقروءًا تحت هذه النسبة. */
export const COMPLETED_READ_RATIO = 0.9;

/**
 * ولا تحت هذا الوقت الفعلي.
 *
 * فتح الفصل ثانية ثم الخروج ليس قراءة. النسبة وحدها لا تكفي: التمرير السريع
 * إلى آخر صفحة يبلغ 100% في ثانيتين.
 */
export const MIN_COMPLETED_READ_MS = 5_000;

// ───────────────────────────── سجل الفروقات ─────────────────────────────

/** صف قابل للمزامنة: الـrev هو موضعه في السجل العام. */
export interface Revisioned {
  rev: number;
}

/**
 * الـcursor التالي للعميل.
 *
 * أعلى rev في الدفعة، ولا يقل عن الحالي أبدًا: دفعة فارغة تعني «لا جديد» لا
 * «ابدأ من الصفر». الرجوع بالـcursor يعيد سحب كل شيء، وهو أسوأ من التوقف.
 */
export function nextCursor(rows: readonly Revisioned[], current: number): number {
  let max = current;
  for (const row of rows) if (row.rev > max) max = row.rev;
  return max;
}

/**
 * هل يحتاج العميل سحبًا كاملًا؟
 *
 * D1 قد تُستعاد من نسخة احتياطية فيعود العدّاد للخلف. عميل يحمل cursor أعلى من
 * عدّاد الخادم لن يرى أي صف جديد أبدًا — يجب أن يعيد البناء من الصفر.
 */
export function needsFullResync(clientCursor: number, serverRev: number): boolean {
  return clientCursor > serverRev;
}

/** صفحة جدول واحد في دفعة الفروقات. */
export interface DeltaPage {
  /** بلغت الصفحة السقف، فبقي في الجدول ما لم يُسلَّم. */
  truncated: boolean;
  /** أعلى rev سُلِّم فعلًا من هذا الجدول. */
  maxRev: number;
}

/**
 * المؤشر بعد دفعة فروقات.
 *
 * السقف يُطبَّق **لكل جدول**، والمؤشر رقمٌ **واحد** مشترك بينها. فأعلى rev في
 * الدفعة كلها ليس مؤشرًا آمنًا: جدولٌ بعيدٌ يسحبه فوق ما لم يُسلَّم من جدول
 * مقطوع، فتُتخطّى صفوفه في الجولة التالية (`rev > cursor`) ولا تُسلَّم أبدًا —
 * والعميل يسمع «أنت محدَّث» وهو ناقص. حدث هذا فعلًا على D1 حقيقية: 600 صفّ
 * نشاط، وُسلِّم 500، وضاعت 100 بلا أثر.
 *
 * فالأمان هو **أصغر** ما بلغه جدولٌ مقطوع. والجداول غير المقطوعة استُنزفت
 * فوق المؤشر القديم، فإعادة تسليم بعض صفوفها في الجولة التالية بلا ضرر:
 * الكتابة عند العميل upsert.
 */
export function nextDeltaCursor(
  pages: readonly DeltaPage[],
  { cursor, serverRev }: { cursor: number; serverRev: number },
): { cursor: number; more: boolean } {
  const capped = pages.filter((page) => page.truncated);

  if (capped.length === 0) {
    // لا قطع: كل شيء فوق المؤشر سُلِّم، فيلحق المؤشر عدّاد الخادم حتى لا
    // يُعاد سحب ما لا جديد فيه.
    let max = cursor;
    for (const page of pages) if (page.maxRev > max) max = page.maxRev;
    return { cursor: Math.max(max, serverRev), more: false };
  }

  let safe = Infinity;
  for (const page of capped) if (page.maxRev < safe) safe = page.maxRev;
  return { cursor: Math.max(cursor, safe), more: true };
}

// ───────────────────────────── العمليات ─────────────────────────────

/**
 * كل عملية يقبلها الـWorker.
 *
 * هذه القائمة **عقد**، لا تعدادٌ للراحة. وقد انحرفت: كان الـWorker يقبل
 * اثنتين وعشرين وهذه تعلن أربع عشرة — فثماني عمليات يعالجها الخادم ولا
 * يعرفها العقد، ومنها `recommendation.respond` و`activity.add` و
 * `progress.confirm` وهي مستعملة فعلًا. والعميل جافاسكربت بلا فحص أنواع،
 * فالانحراف لم يُسقط بناءً ولم يُرَ.
 *
 * وحارسٌ في `tools/repository-safety.test.mjs` يقارن هذه بما يعالجه
 * `services/sync-worker/src/index.ts` ويفشل عند أول اختلاف.
 */
export type OpKind =
  | 'progress.set'
  | 'progress.confirm'
  | 'chapter.complete'
  | 'usage.add'
  | 'profile.patch'
  | 'library.add'
  | 'library.remove'
  | 'favorite.set'
  | 'readLater.set'
  | 'collection.reorder'
  | 'top.set'
  | 'rating.set'
  | 'comment.add'
  | 'reaction.set'
  | 'recommendation.send'
  | 'recommendation.respond'
  | 'activity.add'
  | 'activity.delivered'
  | 'activity.seen'
  | 'notification.read'
  | 'notification.seen'
  | 'settings.patch';

export interface Op {
  opId: string;
  kind: OpKind;
  payload: unknown;
}

/**
 * إسقاط العمليات المكرّرة داخل الدفعة نفسها، مع الحفاظ على الترتيب.
 *
 * طابور العميل قد يحمل نفس العملية مرتين لو أُعيد بناؤه بعد إيقاف مفاجئ.
 * الخادم يحمي نفسه بجدول op_id، لكن تنظيف الدفعة يوفّر رحلة كتابة كاملة.
 */
export function dedupeOps<T extends { opId: string }>(ops: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const op of ops) {
    if (seen.has(op.opId)) continue;
    seen.add(op.opId);
    out.push(op);
  }
  return out;
}

// ───────────────────────────── التقدم ─────────────────────────────

export interface ChapterProgress {
  /** أعلى صفحة وصلها القارئ في هذا الفصل. */
  page: number;
  /** 0..1 */
  ratio: number;
}

/**
 * دمج تقدم فصل: الأعلى يفوز في كل حقل مستقلًا.
 *
 * لا LWW. جهاز خارج الشبكة نصف يوم يزامن حالة قديمة، وآخر كتابة تفوز تعني
 * أن القارئ يجد نفسه رجع 18 صفحة بلا سبب مفهوم. الأعلى لا يرجع أبدًا.
 *
 * الحقلان مستقلان بقصد: صفحة أعلى مع ratio أقل تحدث فعلًا عندما يضيف المصدر
 * صفحات إلى فصل منشور، فأخذ الأعلى من كل حقل يمنع ratio قديم من إلغاء صفحة
 * حقيقية.
 */
export function mergeProgress(
  existing: ChapterProgress | null,
  incoming: ChapterProgress,
): ChapterProgress {
  const ratio = clampRatio(incoming.ratio);
  const page = Math.max(0, Math.floor(incoming.page));
  if (!existing) return { page, ratio };
  return {
    page: Math.max(existing.page, page),
    ratio: Math.max(existing.ratio, ratio),
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * هل هذه قراءة مكتملة؟
 *
 * يُفرض على الخادم أيضًا لا على العميل وحده: عميل معطوب أو نسخة قديمة تستطيع
 * أن ترسل `chapter.complete` لكل فتح، والإحصائيات هي ما يراه الأصدقاء.
 */
export function isCompletedRead(input: { ratio: number; activeMs: number }): boolean {
  return (
    clampRatio(input.ratio) >= COMPLETED_READ_RATIO &&
    input.activeMs >= MIN_COMPLETED_READ_MS
  );
}

// ───────────────────────────── وقت الاستخدام ─────────────────────────────

/**
 * ما تستحقه عملية وقت استخدام.
 *
 * تراكمية لا LWW: الوقت مجموع على الأجهزة. والسقف يمنع عميلًا معطوبًا من
 * كتابة رقم لا يمكن تصحيحه لاحقًا.
 */
export function clampUsageCredit(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.floor(ms), MAX_USAGE_OP_MS);
}

/** سقف النبضة الواحدة، معروضًا هنا حتى يقرأ الـWorker القاعدتين من مكان واحد. */
export const MAX_SINGLE_BEAT_MS = MAX_BEAT_CREDIT_MS;

// ───────────────────────────── الإحصائيات ─────────────────────────────

export interface ChapterReadRow {
  /** مفتاح الفصل الثابت. الإحصاء على الفصول لا الصفحات. */
  chapterKey: string;
  /** كم مرة اكتملت قراءته. 1 = قراءة أولى بلا إعادة. */
  readCount: number;
}

export interface ReadStats {
  /** فصول مختلفة اكتملت قراءتها. */
  uniqueChapters: number;
  /** مجموع مرات القراءة. */
  totalReads: number;
  /** ما زاد عن القراءة الأولى لكل فصل. */
  rereads: number;
}

/**
 * الفصول الفريدة مقابل الإعادات.
 *
 * 10 مرة، 11 مرة، 12 ثلاث مرات ⇒ فريدة 3، إجمالي 5، إعادات 2.
 */
export function readStats(rows: readonly ChapterReadRow[]): ReadStats {
  let uniqueChapters = 0;
  let totalReads = 0;
  for (const row of rows) {
    const count = Math.max(0, Math.floor(row.readCount));
    if (count <= 0) continue;
    uniqueChapters += 1;
    totalReads += count;
  }
  return { uniqueChapters, totalReads, rereads: totalReads - uniqueChapters };
}

// ───────────────────────────── الدمج على مستوى الحقل ─────────────────────────────

/**
 * دمج تعديل جزئي على البروفايل أو الإعدادات، حقلًا حقلًا.
 *
 * على مستوى الحقل لا الصف: لو غيّر جهاز الصورة وغيّر آخر النبذة بينما كان
 * الأول خارج الشبكة، فدمج الصف كله يعني أن أحد التغييرين يُمسح. لكل حقل rev
 * خاص، والأحدث يفوز فيه وحده.
 *
 * الحقل غير الموجود في الوارد لا يُلمس. والقيمة `null` حذف صريح — تُطبَّق.
 */
export function mergeFields<T extends Record<string, unknown>>(
  existing: T,
  existingRevs: Readonly<Record<string, number>>,
  incoming: Partial<T>,
  incomingRev: number,
): { value: T; revs: Record<string, number> } {
  const value = { ...existing };
  const revs = { ...existingRevs };
  for (const key of Object.keys(incoming)) {
    const fieldRev = revs[key] ?? 0;
    // المتساوي لا يفوز: إعادة تسليم نفس العملية لا تغيّر شيئًا
    if (incomingRev <= fieldRev) continue;
    (value as Record<string, unknown>)[key] = incoming[key];
    revs[key] = incomingRev;
  }
  return { value, revs };
}

/**
 * الهوية الداخلية لا تتغير أبدًا.
 *
 * `user_id` يُنشأ مرة واحدة وتُعلّق عليه كل العلاقات. أي تعديل وارد يحمله —
 * من عميل قديم أو طلب مُلفَّق — يُسقط قبل الدمج، لا يُرفض الطلب كله: رفض
 * الطلب يجعل تعديل الاسم يفشل بلا سبب ظاهر للمستخدم.
 */
export const IMMUTABLE_PROFILE_FIELDS = ['userId', 'user_id', 'createdAt', 'created_at'] as const;

export function stripImmutable<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if ((IMMUTABLE_PROFILE_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = patch[key];
  }
  return out as Partial<T>;
}
