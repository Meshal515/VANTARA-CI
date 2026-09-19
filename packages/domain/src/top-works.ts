/**
 * أفضل خمسة أعمال (§9 من وثيقة النظام الاجتماعي).
 *
 * الشرط الحاكم: «لا يجوز أن يكون الترتيب غامضًا أو معتمدًا على خوارزمية
 * اجتماعية معقدة». فهنا لا وزنٌ سرّي ولا نقاط مركّبة — كل صفٍّ يرجع معه
 * **سببه**، والشاشة تستطيع أن تقول للمستخدم لماذا ظهر هذا العمل.
 *
 * والاختيار الصريح يسبق كل شيء: من رتّب أعماله بنفسه فترتيبه هو الجواب،
 * والاشتقاق لا يعمل إلا حين لا يختار أحدٌ شيئًا — وإلا فاجتهادُنا يزاحم
 * قراره.
 *
 * والسقف في **العرض** لا في التخزين: «أول خمسة بترتيبك» قاعدة تُشرح في سطر،
 * وعدُّ الصفوف على الخادم داخل دفعة كتابة يكون هشًّا. فإعادة الترتيب وحدها
 * تغيّر أيَّ خمسة تظهر، وهذا عين ما تطلبه §9.
 */

/** ما يُعرض. الوثيقة تقول خمسة، والرقم هنا لا في الشاشات. */
export const TOP_WORKS_LIMIT = 5;

/** سبب ظهور العمل. يُعرض للمستخدم عند الحاجة، ولا يُخفى. */
export type TopWorkBasis = 'chosen' | 'rating' | 'reread';

export interface TopWorkItem {
  seriesRef: string;
  basis: TopWorkBasis;
  /** القيمة التي رتّبته: الموضع للمختار، والدرجة أو عدد القراءات للمشتقّ. */
  score: number;
}

export interface TopWorksResult {
  items: TopWorkItem[];
  /** `chosen` اختيارٌ صريح · `derived` اشتقاق · `empty` لا شيء بعد. */
  source: 'chosen' | 'derived' | 'empty';
}

export interface ChosenRow {
  seriesRef: string;
  position?: number | null;
  member?: number | null;
}

/** الترتيب الثابت عند التعادل: صفوفٌ ترقص في كل مزامنة تُقرأ كعطل. */
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function topWorks({
  chosen = [],
  ratings = [],
  chapterReads = [],
  limit = TOP_WORKS_LIMIT,
}: {
  chosen?: readonly ChosenRow[];
  ratings?: readonly { seriesRef: string; score: number }[];
  chapterReads?: readonly { seriesRef: string; readCount: number }[];
  limit?: number;
}): TopWorksResult {
  const picked = chosen
    .filter((row) => row.member !== 0 && typeof row.seriesRef === 'string' && row.seriesRef !== '')
    .map((row) => ({
      seriesRef: row.seriesRef,
      basis: 'chosen' as const,
      score: Number(row.position ?? 0),
    }))
    .sort((a, b) => a.score - b.score || byName(a.seriesRef, b.seriesRef));

  if (picked.length > 0) {
    return { items: picked.slice(0, limit), source: 'chosen' };
  }

  // الاشتقاق: الدرجة صوتٌ صريح فتسبق، وإعادة القراءة صوتٌ بالفعل فتليها.
  // ولا يُجمع الاثنان في رقم واحد: ذلك هو الغموض الذي تمنعه §9.
  const rated = ratings
    .filter((row) => typeof row.seriesRef === 'string' && Number.isFinite(row.score))
    .map((row) => ({ seriesRef: row.seriesRef, basis: 'rating' as const, score: row.score }))
    .sort((a, b) => b.score - a.score || byName(a.seriesRef, b.seriesRef));

  const seen = new Set(rated.map((row) => row.seriesRef));
  const reread = chapterReads
    .filter(
      (row) =>
        typeof row.seriesRef === 'string' &&
        Number.isFinite(row.readCount) &&
        !seen.has(row.seriesRef),
    )
    .map((row) => ({ seriesRef: row.seriesRef, basis: 'reread' as const, score: row.readCount }))
    .sort((a, b) => b.score - a.score || byName(a.seriesRef, b.seriesRef));

  const items = [...rated, ...reread].slice(0, limit);
  return { items, source: items.length > 0 ? 'derived' : 'empty' };
}
