/**
 * التنزيلات — على الجهاز وحده.
 *
 * قاعدة الملكية (B4): `device.downloads` يملكه الجهاز. الفصول المنزّلة وكاش
 * الصور لا تصل D1 ولا PostgreSQL: رفعها يسرّب المحتوى ويفجّر الحجم بلا فائدة،
 * ولا يستفيد منه جهاز آخر لأن الملفات ليست عنده أصلًا.
 *
 * ما هنا هو **عقد** البيان المحلي وقواعد إخلاء المساحة، لا مخزن. الشاشة تقرأه،
 * والجهاز يكتبه، ولا يُزامَن.
 *
 * قاعدتان حاكمتان:
 *
 * 1. **الفصل الذي يُقرأ الآن لا يُخلى.** الإخلاء أثناء القراءة يمسح صفحات أمام
 *    القارئ ويجعل الفصل يبدو معطوبًا.
 *
 * 2. **الفاشل يُخلى أولًا.** بايتات محجوزة لتنزيل لم يكمل ليست محتوى، والقارئ
 *    لا يخسر شيئًا بإسقاطها.
 */

export const DOWNLOAD_STATES = ['queued', 'fetching', 'ready', 'failed'] as const;

export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export interface DownloadEntry {
  seriesRef: string;
  chapterKey: string;
  chapterNumber?: number | null;
  state: DownloadState;
  /** عدد الصفحات المكتملة، لا المتوقع. */
  pages?: number | null;
  bytes?: number | null;
  savedAt?: number | null;
  /** آخر قراءة من هذه النسخة المحلية. أساس الإخلاء. */
  lastReadAt?: number | null;
}

/** السقف الافتراضي للمساحة: يُضبط من الإعدادات، وهذا احتياط معقول. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** الحقول التي لا يجوز أن تخرج من الجهاز إلى أي مخزن مشترك. */
export const DEVICE_ONLY_DOWNLOAD_FIELDS = ['bytes', 'pages', 'savedAt', 'state'] as const;

function size(entry: DownloadEntry): number {
  const bytes = Number(entry.bytes ?? 0);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

export interface DownloadSummary {
  seriesRef: string;
  chapters: number;
  ready: number;
  failed: number;
  bytes: number;
  lastReadAt: number;
}

/**
 * تجميع لكل عمل، كما تعرضه شاشة التنزيلات.
 *
 * مرتّب بآخر قراءة: ما يقرأه المستخدم الآن في الأعلى، لا ما نزّله أولًا.
 */
export function downloadSummary(entries: readonly DownloadEntry[]): DownloadSummary[] {
  const bySeries = new Map<string, DownloadSummary>();
  for (const entry of entries) {
    const current =
      bySeries.get(entry.seriesRef) ??
      { seriesRef: entry.seriesRef, chapters: 0, ready: 0, failed: 0, bytes: 0, lastReadAt: 0 };
    current.chapters += 1;
    if (entry.state === 'ready') current.ready += 1;
    if (entry.state === 'failed') current.failed += 1;
    current.bytes += size(entry);
    current.lastReadAt = Math.max(current.lastReadAt, Number(entry.lastReadAt ?? 0));
    bySeries.set(entry.seriesRef, current);
  }
  return [...bySeries.values()].sort((a, b) => b.lastReadAt - a.lastReadAt);
}

export function totalDownloadBytes(entries: readonly DownloadEntry[]): number {
  return entries.reduce((total, entry) => total + size(entry), 0);
}

export interface EvictionPlan {
  /** ما يُحذف، بالترتيب. */
  evict: DownloadEntry[];
  /** الحجم المتوقع بعد الإخلاء. */
  bytesAfter: number;
  /** لم يبلغ السقف ولو أخلينا كل ما يجوز إخلاؤه. */
  stillOverBudget: boolean;
}

/**
 * خطة إخلاء المساحة.
 *
 * الترتيب: الفاشل، ثم الأقدم قراءةً. الفصل المُستثنى (يُقرأ الآن) لا يُخلى
 * أبدًا، ولا `fetching` — إخلاؤه يترك ملفات نصف منزّلة بلا صاحب.
 */
export function planEviction(input: {
  entries: readonly DownloadEntry[];
  maxBytes?: number;
  keepChapterKeys?: readonly string[];
}): EvictionPlan {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const keep = new Set(input.keepChapterKeys ?? []);
  let total = totalDownloadBytes(input.entries);
  if (total <= maxBytes) return { evict: [], bytesAfter: total, stillOverBudget: false };

  const candidates = input.entries
    .filter((entry) => !keep.has(entry.chapterKey) && entry.state !== 'fetching')
    .sort((a, b) => {
      // الفاشل أولًا: بايتات بلا محتوى
      if ((a.state === 'failed') !== (b.state === 'failed')) return a.state === 'failed' ? -1 : 1;
      // ثم الأقدم قراءةً؛ وما لم يُقرأ أبدًا (0) قبل ما قُرئ
      return Number(a.lastReadAt ?? 0) - Number(b.lastReadAt ?? 0);
    });

  const evict: DownloadEntry[] = [];
  for (const entry of candidates) {
    if (total <= maxBytes) break;
    evict.push(entry);
    total -= size(entry);
  }

  return { evict, bytesAfter: total, stillOverBudget: total > maxBytes };
}

/**
 * ما يستحق التنزيل التالي عند «نزّل الفصول القادمة».
 *
 * يتخطّى ما هو منزَّل أو في الطابور، ويرتّب تصاعديًا بالرقم: القارئ يريد الفصل
 * الذي يليه، لا أحدث فصل صدر.
 */
export function nextDownloadTargets(input: {
  have: readonly DownloadEntry[];
  wanted: readonly { chapterKey: string; seriesRef: string; number: number }[];
  after: number;
  limit?: number;
}): { chapterKey: string; seriesRef: string; number: number }[] {
  const known = new Set(
    input.have.filter((entry) => entry.state !== 'failed').map((entry) => entry.chapterKey),
  );
  return input.wanted
    .filter((target) => target.number > input.after && !known.has(target.chapterKey))
    .sort((a, b) => a.number - b.number)
    .slice(0, Math.max(0, input.limit ?? 3));
}
