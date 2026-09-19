/**
 * اقرأوا سوا (§25) والمنافسة الصامتة (§26).
 *
 * لا جدول ولا مسار ولا حالة مخزَّنة: `chapter_reads` يُزامَن لكل الأجهزة
 * أصلًا، فأعلى فصلٍ لكل شخص يُشتقّ عند العرض. و§26 تقول صراحة إن المقارنة
 * وحدها تكفي — «أنت 95 · منصور 97» — بلا نقاط ولا مستويات ولا عملات. فأرخص
 * تنفيذ هو الأصحّ هنا: ما لا يُخزَّن لا يفسد ولا يحتاج هجرة.
 *
 * وملاحظة على §7: الإخفاء يحجب «يقرأ الآن» وتفاصيله الحاضرة، ولا يحجب هذه
 * اللوحة — §25 كلها قائمة على أن التقدّم مشترك، ولو حجبها الإخفاء لفقدت
 * معناها. وهذه قراءتي للوثيقة، وقد سألتُ المالك عنها.
 */

export interface ChapterRead {
  userId: string;
  seriesRef: string;
  chapterNumber?: number | null;
}

export interface BoardRow {
  userId: string;
  /** أعلى فصلٍ بلغه في هذا العمل. */
  chapter: number;
  isViewer: boolean;
}

export interface Board {
  rows: BoardRow[];
  /** أعلى فصل في المجموعة، أو `null` إن لم يقرأه أحد. */
  leaderChapter: number | null;
  /** فصل القارئ نفسه، أو `null` إن لم يبدأه. */
  viewerChapter: number | null;
  /** كم فصلًا يسبقه المتقدّم. `0` إن كان هو المتقدّم، و`null` إن لم يبدأ. */
  behindBy: number | null;
}

export function readTogether({
  seriesRef,
  reads,
  viewerId,
}: {
  seriesRef: string;
  reads: readonly ChapterRead[];
  viewerId: string;
}): Board {
  /** أعلى فصل لكل شخص. من لم يفتح العمل لا يظهر: صفرٌ مُختلق يقول «وقف». */
  const furthest = new Map<string, number>();
  for (const read of reads) {
    if (read.seriesRef !== seriesRef) continue;
    // فصلٌ بلا رقم لا يمكن ترتيبه، وإدخاله بصفر يضع صاحبه في الذيل بالخطأ
    if (!Number.isFinite(read.chapterNumber)) continue;
    const chapter = Number(read.chapterNumber);
    const current = furthest.get(read.userId);
    if (current === undefined || chapter > current) furthest.set(read.userId, chapter);
  }

  const rows = [...furthest.entries()]
    .map(([userId, chapter]) => ({ userId, chapter, isViewer: userId === viewerId }))
    // الترتيب الثابت عند التعادل: لوحةٌ ترقص في كل مزامنة تُقرأ كعطل
    .sort((a, b) => b.chapter - a.chapter || (a.userId < b.userId ? -1 : 1));

  const leaderChapter = rows[0]?.chapter ?? null;
  const viewerChapter = furthest.get(viewerId) ?? null;
  const behindBy =
    viewerChapter === null || leaderChapter === null
      ? null
      : Math.max(0, leaderChapter - viewerChapter);

  return { rows, leaderChapter, viewerChapter, behindBy };
}
