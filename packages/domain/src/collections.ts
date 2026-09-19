/**
 * المجموعات: المفضلة وأقرأ لاحقًا.
 *
 * الاثنتان عضوية بشاهد قبر في جدول واحد (`collections`)، لأن دلالتهما واحدة
 * تمامًا: دخول، خروج، وترتيب يختاره المستخدم. جدولان كانا يعنيان نسختين من
 * منطق الدمج نفسه.
 *
 * ثلاث قواعد حاكمة:
 *
 * 1. **العضوية ليست حذفًا.** الخروج يُكتب `member = 0` ويُزامَن؛ الحذف الصامت لا
 *    يُزامَن فيعود العمل عند أول مزامنة من جهاز آخر.
 *
 * 2. **الوصف منفصل عن العضوية.** الصف يحمل `series_ref` فقط، والعنوان والغلاف
 *    في `works`. بلا ذلك تُخزَّن نفس بيانات العمل في أربعة أماكن — المكتبة
 *    والتوصيات والإشعارات والنشاط — وتتفرّق. وبلا وصف أصلًا تعرض الشاشة
 *    معرّفًا خامًا: هذا هو ما كان يحدث لعمل يُضاف للمفضلة من صفحته.
 *
 * 3. **الترتيب صريح أو زمني.** `position` إن وُجد، وإلا الأحدث أولًا. الخلط
 *    بينهما يجعل القائمة ترقص عند كل مزامنة.
 */

// `top` هي «أفضل 5» (§9): مجموعة مرتَّبة كالمفضلة، لا جدولٌ ثالث ولا حقل
// في البروفايل. السقف في العرض (`topWorks`) لا في التخزين.
export const COLLECTION_KINDS = ['favorite', 'read_later', 'top'] as const;

export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export function isCollectionKind(value: unknown): value is CollectionKind {
  return typeof value === 'string' && (COLLECTION_KINDS as readonly string[]).includes(value);
}

/** سقف العضوية لكل نوع. الحدّ حماية للمزامنة لا قرار منتج. */
export const MAX_COLLECTION_ITEMS = 500;

/** صف العضوية كما يصل من D1. */
export interface CollectionRow {
  series_ref: string;
  kind: string;
  member?: number | boolean | null;
  position?: number | null;
  updated_at?: number | null;
}

/** وصف العمل للعرض. مالك الحقيقة هو Uchiyomi؛ هذا مرآة اجتماعية. */
export interface WorkDescriptor {
  series_ref: string;
  title?: string | null;
  cover_url?: string | null;
  source_id?: string | null;
  updated_at?: number | null;
}

export interface CollectionItem {
  seriesRef: string;
  title: string | null;
  coverUrl: string | null;
  sourceId: string | null;
  position: number | null;
  updatedAt: number;
  /** لا وصف لهذا العمل: الشاشة لا تستطيع عرض أكثر من معرّف. */
  needsDescriptor: boolean;
}

/** العضوية افتراضها نعم: العمود الافتراضي في المخطط `1`، والخروج يُكتب صراحة. */
function isMember(row: CollectionRow): boolean {
  return row.member !== 0 && row.member !== false;
}

/**
 * القائمة كما تُعرض.
 *
 * التصفية بالنوع والعضوية، ثم الترتيب: الموضع الصريح أولًا تصاعديًا، ثم من بلا
 * موضع بالأحدث. وكل عنصر يُعلَّم إن كان بلا وصف، فالنقص يُرى ولا يُخمَّن.
 */
export function collectionView(input: {
  rows: readonly CollectionRow[];
  works?: readonly WorkDescriptor[];
  kind: CollectionKind;
  limit?: number;
}): CollectionItem[] {
  const byRef = new Map<string, WorkDescriptor>();
  for (const work of input.works ?? []) byRef.set(work.series_ref, work);

  const items = input.rows
    .filter((row) => row.kind === input.kind && isMember(row))
    .map((row): CollectionItem => {
      const work = byRef.get(row.series_ref);
      const title = work?.title ?? null;
      return {
        seriesRef: row.series_ref,
        title,
        coverUrl: work?.cover_url ?? null,
        sourceId: work?.source_id ?? null,
        position: typeof row.position === 'number' ? row.position : null,
        updatedAt: Number(row.updated_at ?? 0),
        needsDescriptor: title === null,
      };
    });

  items.sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return b.updatedAt - a.updatedAt;
  });

  return typeof input.limit === 'number' ? items.slice(0, input.limit) : items;
}

/** الأعمال المعروضة بلا وصف. تشخيص صريح بدل شاشة فيها بطاقات فارغة. */
export function missingDescriptors(input: {
  rows: readonly CollectionRow[];
  works?: readonly WorkDescriptor[];
  kind: CollectionKind;
}): string[] {
  return collectionView({ ...input })
    .filter((item) => item.needsDescriptor)
    .map((item) => item.seriesRef);
}

/** الموضع التالي في النهاية. */
export function nextPosition(rows: readonly CollectionRow[], kind: CollectionKind): number {
  const positions = rows
    .filter((row) => row.kind === kind && isMember(row) && typeof row.position === 'number')
    .map((row) => row.position as number);
  return positions.length === 0 ? 0 : Math.max(...positions) + 1;
}

/**
 * ترتيب جديد بعد سحب عنصر إلى موضع.
 *
 * يُعيد مواضع **كل** العناصر مُعادة الترقيم 0..n-1: المواضع المتفرقة تبدو أرخص
 * لكنها تتشابك بين جهازين، وإعادة الترقيم الكاملة عملية واحدة مفهومة.
 */
export function reorderCollection(input: {
  rows: readonly CollectionRow[];
  kind: CollectionKind;
  seriesRef: string;
  toIndex: number;
}): { seriesRef: string; position: number }[] {
  const current = collectionView({ rows: input.rows, kind: input.kind }).map((item) => item.seriesRef);
  const from = current.indexOf(input.seriesRef);
  if (from === -1) return [];

  const target = Math.min(Math.max(0, Math.floor(input.toIndex)), current.length - 1);
  const ordered = [...current];
  ordered.splice(from, 1);
  ordered.splice(target, 0, input.seriesRef);

  return ordered.map((seriesRef, position) => ({ seriesRef, position }));
}

/**
 * دمج وصف عمل.
 *
 * الأحدث يفوز حقلًا بحقل، والقيمة الفارغة لا تمحو قيمة قائمة: مصدر يرجع بلا
 * غلاف لا يجوز أن يمحو غلافًا وصلنا من مصدر آخر.
 */
export function mergeWork(
  existing: WorkDescriptor | null,
  incoming: WorkDescriptor,
): WorkDescriptor {
  if (!existing) return { ...incoming };
  const newer = Number(incoming.updated_at ?? 0) >= Number(existing.updated_at ?? 0);
  /** القيمة الفارغة لا تمحو قيمة قائمة، و`undefined` لا تظهر في المخرجات. */
  const pick = (key: 'title' | 'cover_url' | 'source_id'): string | null => {
    const candidate = incoming[key];
    const held = existing[key] ?? null;
    if (candidate === null || candidate === undefined || candidate === '') return held;
    return newer ? candidate : (held ?? candidate);
  };
  return {
    series_ref: existing.series_ref,
    title: pick('title'),
    cover_url: pick('cover_url'),
    source_id: pick('source_id'),
    updated_at: Math.max(Number(existing.updated_at ?? 0), Number(incoming.updated_at ?? 0)),
  };
}
