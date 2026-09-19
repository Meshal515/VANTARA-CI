/**
 * فهرس فصول العمل، مجموعًا من كل المصادر.
 *
 * المشكلة التي يحلّها هذا الملف بالضبط: عمل يظهر بفصوله من 1 إلى 60، ثم يقفز
 * إلى 200، ثم ينتهي عند 400 وله 700 فصل. القارئ يرى ذلك كعمل ناقص، والسبب
 * ليس المصدر — بل ثلاثة أشياء في طبقتنا:
 *
 *   1. الخادم يحمل بعض الفصول فقط (`/books`)، والباقي «أشباح» يعرضها المصدر
 *      ولم تُجلب (`/listing`). من يقرأ الأول وحده يرى عملًا مقطوعًا.
 *   2. لكل رقم فصل نسخ من مصادر مختلفة (`/versions`). مصدر ساقط لا يعني
 *      اختفاء الفصل — نسخة أخرى تحمله.
 *   3. الغياب له أسباب مختلفة تمامًا: `floor` يعني أن العمل مضبوط على «آخر N
 *      فصلًا» فالأقدم مستُثنى بقرار، و`blocked` يعني مجموعة محجوبة، و`failed`
 *      يعني محاولات نفدت. إخفاؤها كلها كـ«غير موجود» يجعل العطل غامضًا.
 *
 * فالفهرس هنا يوحّد الثلاثة في قائمة واحدة مرتّبة، لكل رقم حالته ونسخه، ثم
 * `auditCoverage` يقول صراحةً أي أرقام غائبة — لأن «أظن أنها كاملة» ليست
 * إجابة.
 */

/** فصل يحمله الخادم فعلًا، من `/api/series/{id}/books`. */
export interface HeldChapter {
  id: string;
  number: number;
  name?: string | null;
  read?: boolean;
}

/** رقم يعرضه المصدر ولا يحمله الخادم، من `/api/series/{id}/listing`. */
export interface GhostChapter {
  number: number;
  title?: string | null;
  why: 'missing' | 'held' | 'blocked' | 'failed' | 'floor';
  sourceId?: string | null;
  sourceName?: string | null;
  groups?: string[];
  attempts?: number;
  waitingFor?: string | null;
  waitDaysLeft?: number | null;
}

/** نسخة واحدة من رقم فصل عند مصدر، من `/api/series/{id}/versions`. */
export interface ChapterCopy {
  key: string;
  source: string;
  sourceName?: string | null;
  lang?: string | null;
  /** 0 = رابط خارجي غير قابل للتنزيل. null = المصدر لا يقول. */
  pages?: number | null;
  scanlator?: string | null;
  groups?: string[];
  chosen?: boolean;
  blocked?: boolean;
  onDisk?: boolean;
  publishedAt?: string | null;
}

export type ChapterState = 'ON_DISK' | 'MISSING' | 'HELD' | 'BLOCKED' | 'FAILED' | 'BELOW_FLOOR';

const STATE_OF_WHY: Record<GhostChapter['why'], ChapterState> = {
  missing: 'MISSING',
  held: 'HELD',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  floor: 'BELOW_FLOOR',
};

export interface CatalogueEntry {
  number: number;
  state: ChapterState;
  /** معرّف الكتاب عند الخادم. موجود ⇒ يُقرأ الآن بلا جلب. */
  bookId?: string;
  title?: string | null;
  read?: boolean;
  /** كل النسخ المعروفة لهذا الرقم، من كل مصدر. */
  copies: ChapterCopy[];
  /** هل يمكن الوصول إليه الآن أو بجلب نسخة؟ */
  readable: boolean;
  /** سبب الغياب بصيغة تُعرض للمستخدم، عند وجوده. */
  why?: GhostChapter['why'];
  attempts?: number;
  waitingFor?: string | null;
  waitDaysLeft?: number | null;
}

/**
 * أرقام الفصول تأتي كأعداد عشرية (12.5 لفصل إضافي) وبفوارق تمثيل.
 * التوحيد على منزلتين يمنع 12.499999 و12.5 من أن يصيرا فصلين.
 */
function normalizeNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * هل يمكن جلب هذه النسخة أصلًا؟
 *
 * الرابط الخارجي (`pages === 0`) وحده غير قابل: لا شيء يُنزَّل منه، فاعتباره
 * قابلًا للقراءة كذب على القارئ.
 *
 * والمحجوب **قابل** بقصد: `picks` في `/api/sources/fetch` تتجاوز قواعد
 * المجموعات والحجب صراحةً — «اختيار صريح لنسخة واحدة» بنصّ العقد. فالحجب
 * يؤخّر النسخة في الترتيب ولا يُخفي الفصل، وهذا ما يمنع فصلًا من الاختفاء
 * لأن مجموعته محجوبة.
 */
function isFetchable(copy: ChapterCopy): boolean {
  return copy.pages !== 0;
}

/**
 * يبني الفهرس الكامل.
 *
 * الأرقام تأتي من المصادر الثلاثة معًا، ولا يُسقط رقم ظهر في أيٍّ منها: عمل
 * ظهر رقمه في `versions` وحده — وهو ما يحدث لأرقام فُحصت بعد آخر sweep — يبقى
 * في القائمة بنسخه.
 */
export function buildCatalogue(input: {
  held?: readonly HeldChapter[];
  ghosts?: readonly GhostChapter[];
  versions?: readonly { number: number; copies?: readonly ChapterCopy[] }[];
}): CatalogueEntry[] {
  const byNumber = new Map<number, CatalogueEntry>();

  const entryFor = (rawNumber: number): CatalogueEntry | null => {
    if (!Number.isFinite(rawNumber)) return null;
    const number = normalizeNumber(rawNumber);
    let entry = byNumber.get(number);
    if (!entry) {
      entry = { number, state: 'MISSING', copies: [], readable: false };
      byNumber.set(number, entry);
    }
    return entry;
  };

  // الأشباح أولًا: الحالة والسبب منها
  for (const ghost of input.ghosts ?? []) {
    const entry = entryFor(ghost.number);
    if (!entry) continue;
    entry.state = STATE_OF_WHY[ghost.why] ?? 'MISSING';
    entry.why = ghost.why;
    if (ghost.title != null) entry.title = ghost.title;
    if (ghost.attempts !== undefined) entry.attempts = ghost.attempts;
    if (ghost.waitingFor !== undefined) entry.waitingFor = ghost.waitingFor;
    if (ghost.waitDaysLeft !== undefined) entry.waitDaysLeft = ghost.waitDaysLeft;
  }

  // النسخ: مصدر الاختيار والبديل
  for (const version of input.versions ?? []) {
    const entry = entryFor(version.number);
    if (!entry) continue;
    entry.copies = [...(version.copies ?? [])];
  }

  // المحمول أخيرًا: وجوده على القرص يغلب أي سبب غياب سابق لنفس الرقم
  for (const chapter of input.held ?? []) {
    const entry = entryFor(chapter.number);
    if (!entry) continue;
    entry.state = 'ON_DISK';
    entry.bookId = chapter.id;
    delete entry.why;
    if (chapter.name != null) entry.title = chapter.name;
    if (chapter.read !== undefined) entry.read = chapter.read;
  }

  for (const entry of byNumber.values()) {
    entry.readable = entry.state === 'ON_DISK' || entry.copies.some(isFetchable);
  }

  // تصاعديًا: هذا ترتيب القراءة، والقارئ المتصل يتبعه
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export interface CoverageReport {
  first: number | null;
  last: number | null;
  /** الأرقام الصحيحة المتوقعة بين الأول والأخير. */
  expected: number;
  /** الأرقام الصحيحة الموجودة فعلًا في الفهرس. */
  present: number;
  /** أرقام صحيحة لم يعرضها أي مصدر. فراغ حقيقي. */
  missing: number[];
  /** موجودة لكن لا تُقرأ الآن ولا بجلب: كل نسخها محجوبة أو روابط خارجية. */
  unreadable: number[];
  /** موجودة ومستثناة بقرار: أرضية «آخر N فصلًا» أو مجموعة محجوبة. */
  withheld: number[];
  complete: boolean;
}

/**
 * يقيس التغطية ويسمّي الفراغ.
 *
 * الفرق الذي يهم: رقم **لم يعرضه أي مصدر** فراغ حقيقي، ورقم معروض وغير
 * منزّل ليس فراغًا — يُجلب عند فتحه. خلط الاثنين يجعل كل عمل يبدو مكسورًا،
 * أو يجعل عملًا مكسورًا يبدو سليمًا.
 *
 * العدّ على الأرقام الصحيحة وحدها: الفصول الإضافية (12.5) لا توجد لكل عمل،
 * وغيابها ليس نقصًا.
 */
export function auditCoverage(entries: readonly CatalogueEntry[]): CoverageReport {
  if (entries.length === 0) {
    return {
      first: null,
      last: null,
      expected: 0,
      present: 0,
      missing: [],
      unreadable: [],
      withheld: [],
      complete: true,
    };
  }

  const numbers = entries.map((entry) => entry.number);
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);

  const integers = new Set<number>();
  for (const entry of entries) {
    if (Number.isInteger(entry.number)) integers.add(entry.number);
  }

  // الأرضية من الرقم الأول فعلًا: أعمال تبدأ من 0 وأخرى من 1، وفرض 1 يخترع
  // فراغًا في الأولى ويُخفي فصلًا في الثانية
  const start = Math.floor(first);
  const end = Math.floor(last);
  const missing: number[] = [];
  for (let n = start; n <= end; n += 1) {
    if (!integers.has(n)) missing.push(n);
  }

  const unreadable = entries
    .filter((entry) => !entry.readable && entry.state !== 'ON_DISK')
    .map((entry) => entry.number);
  const withheld = entries
    .filter((entry) => entry.state === 'BELOW_FLOOR' || entry.state === 'BLOCKED')
    .map((entry) => entry.number);

  return {
    first,
    last,
    expected: end - start + 1,
    present: integers.size,
    missing,
    unreadable,
    withheld,
    complete: missing.length === 0,
  };
}

/** ترتيب تفضيل اللغة. العربي أولًا، ثم الإنجليزي، ثم الباقي. */
const LANG_RANK: Record<string, number> = { ar: 0, en: 1 };

export interface PickOptions {
  /** مفاتيح نسخ تُستثنى: ما فشل في هذه الجلسة. */
  exclude?: ReadonlySet<string>;
  preferLang?: string;
}

/**
 * يختار أفضل نسخة قابلة للجلب.
 *
 * الترتيب مقصود: الموجود على القرص أولًا (بلا شبكة)، ثم ما اختارته قواعد
 * الإصدار، ثم اللغة المفضّلة، ثم الأكثر صفحات — نسخة بصفحتين لفصل من عشرين
 * صفحة نسخة مبتورة —، ثم الأحدث.
 *
 * `exclude` هو ما يجعل «بدّل المصدر» يعمل: النسخة التي فشلت تُستثنى وتُعاد
 * المحاولة بالتالية، فلا يتوقف القارئ عند فصل تالف.
 */
export function pickCopy(
  copies: readonly ChapterCopy[],
  options: PickOptions = {},
): ChapterCopy | null {
  const exclude = options.exclude ?? new Set<string>();
  const preferLang = options.preferLang ?? 'ar';

  const usable = copies.filter((copy) => isFetchable(copy) && !exclude.has(copy.key));
  if (usable.length === 0) return null;

  const rankLang = (lang: string | null | undefined): number => {
    if (!lang) return 9;
    if (lang === preferLang) return -1;
    return LANG_RANK[lang] ?? 8;
  };

  return [...usable].sort((a, b) => {
    if ((b.onDisk === true ? 1 : 0) !== (a.onDisk === true ? 1 : 0)) {
      return (b.onDisk === true ? 1 : 0) - (a.onDisk === true ? 1 : 0);
    }
    // المحجوب أخيرًا لا مستبعدًا: يُجلب بـpick صريح عند غياب غيره
    if ((a.blocked === true ? 1 : 0) !== (b.blocked === true ? 1 : 0)) {
      return (a.blocked === true ? 1 : 0) - (b.blocked === true ? 1 : 0);
    }
    if ((b.chosen === true ? 1 : 0) !== (a.chosen === true ? 1 : 0)) {
      return (b.chosen === true ? 1 : 0) - (a.chosen === true ? 1 : 0);
    }
    const lang = rankLang(a.lang) - rankLang(b.lang);
    if (lang !== 0) return lang;
    const pages = (b.pages ?? 0) - (a.pages ?? 0);
    if (pages !== 0) return pages;
    return String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''));
  })[0]!;
}

/**
 * الفصل التالي في ترتيب القراءة.
 *
 * يتخطّى ما لا يُقرأ: القارئ المتصل لا يجوز أن يتوقف عند رقم كل نسخه محجوبة،
 * ولا أن يعرض فاصلًا لفصل لا يستطيع فتحه.
 */
export function nextReadable(
  entries: readonly CatalogueEntry[],
  after: number,
): CatalogueEntry | null {
  for (const entry of entries) {
    if (entry.number > after && entry.readable) return entry;
  }
  return null;
}

/** أحدث فصل قابل للقراءة: ما يفتحه زر «اقرأ الآن». */
export function latestReadable(entries: readonly CatalogueEntry[]): CatalogueEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.readable) return entry;
  }
  return null;
}

/**
 * موضع الاستكمال: أول فصل غير مقروء، وإلا آخر فصل مقروء.
 *
 * «متابعة القراءة» يجب أن تفتح ما لم يُقرأ لا ما بعده: القارئ الذي أنهى 197
 * يريد 198، ومن لم يبدأ يريد الأول.
 */
export function resumePoint(entries: readonly CatalogueEntry[]): CatalogueEntry | null {
  const readable = entries.filter((entry) => entry.readable);
  if (readable.length === 0) return null;
  const unread = readable.find((entry) => entry.read !== true);
  return unread ?? readable[readable.length - 1]!;
}

// ─────────────────────── ترتيب الفصول ───────────────────────
//
// كان هذا في `spoilers.ts` لأن الحجب القديم احتاج مقارنة فصلين. وقد أُسقط
// ذلك النموذج (الحرق صار يدويًّا من الكاتب)، والترتيب نفسه يبقى: §25 «اقرأوا
// سوا» تحتاج صفَّ فصولٍ مرتَّبًا، والمقدّمة والخاتمة والأرقام العشرية لها
// موضعها الصحيح هنا لا في وحدة الحرق.

export interface ChapterOrder {
  number?: number;
  kind?: 'prologue' | 'numbered' | 'special' | 'epilogue';
}

/** المقدّمة قبل كل شيء والخاتمة بعده، وبينهما الرقم — والخاص بعد نظيره. */
export function orderKey(chapter: ChapterOrder): [number, number] {
  if (chapter.kind === 'prologue') return [-1, 0];
  if (chapter.kind === 'epilogue') return [1, 0];
  return [0, chapter.number ?? 0];
}

export function compareChapters(a: ChapterOrder, b: ChapterOrder): number {
  const [groupA, numberA] = orderKey(a);
  const [groupB, numberB] = orderKey(b);
  if (groupA !== groupB) return groupA - groupB;
  if (numberA !== numberB) return numberA - numberB;
  // فصلان بنفس الرقم: الخاص بعد المرقَّم
  const rank = (kind?: string) => (kind === 'special' ? 1 : 0);
  return rank(a.kind) - rank(b.kind);
}
