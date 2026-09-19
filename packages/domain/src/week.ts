/**
 * ملخص الأسبوع (§32 من نصّ المالك).
 *
 * **يُحسب عند الفتح، لا بمهمة مجدولة.** `wrangler.toml` عندنا بلا cron
 * بقرار معلن، ومهمةٌ مجدولة تفشل بصمت أسوأ من حسابٍ يُعاد كل مرة — والمدى
 * أسبوع واحد لثلاثة مستخدمين، فالحساب أرخص من جدولته.
 *
 * وهذه الوحدة **لا تلمس قاعدة بيانات**: تأخذ الصفوف كما قرأها النداء وتردّ
 * الملخص. فتُختبر بلا D1 ولا شبكة، وتُعاد قراءتها كقواعد لا كاستعلام.
 *
 * وحدٌّ مقصود: `chapter_reads.read_count` تراكميّ ولا تاريخ له، فـ«إعادة
 * قراءة **هذا الأسبوع**» لا تُشتقّ بدقّة. نعدّ الفصل الذي لُمس في المدى
 * وعدّاده أكبر من واحد، ونسمّيها إعادة. وهي تقريبٌ صادق لا قياس.
 *
 * وما لا تحتمله البيانات لا يُخترع: §32 يذكر «أكثر من غيّر تقييمه»، وجدول
 * `ratings` يحفظ الدرجة الحالية بلا تاريخ. فهذه اللحظة **غير مبنيّة**، ولا
 * تُقدَّر بتخمين.
 */

export interface WeekDay {
  userId: string;
  /** يوم بصيغة `YYYY-MM-DD` كما يكتبه `usage_daily`. */
  day: string;
  activeMs: number;
}

export interface WeekRead {
  userId: string;
  seriesRef: string;
  chapterKey: string;
  readCount: number;
  lastReadAt: number;
}

export interface WeekRating {
  userId: string;
  seriesRef: string;
  score: number;
  updatedAt: number;
}

export interface WeekAccount {
  userId: string;
  displayName: string;
}

export interface WeekPerson {
  userId: string;
  displayName: string;
  chapters: number;
  rereads: number;
  activeMs: number;
  /** العمل الأكثر قراءةً لهذا الشخص في المدى، أو `null` إن لم يقرأ. */
  topSeries: string | null;
}

export type WeekMoment =
  | { kind: 'MOST_READ'; userId: string; chapters: number }
  | { kind: 'MOST_REREAD'; userId: string; rereads: number }
  | { kind: 'SHARED_WORK'; seriesRef: string }
  | { kind: 'LOWEST_RATING'; userId: string; seriesRef: string; score: number };

export interface WeekSummary {
  from: number;
  to: number;
  people: WeekPerson[];
  moments: WeekMoment[];
}

export interface WeekInput {
  accounts: WeekAccount[];
  days?: WeekDay[];
  reads?: WeekRead[];
  ratings?: WeekRating[];
}

export interface WeekWindow {
  /** شامل. */
  from: number;
  /** غير شامل، فأسبوعان متتاليان لا يتقاسمان لحظةً واحدة. */
  to: number;
}

/** `YYYY-MM-DD` إلى بداية يومه بالتوقيت العالمي. يوم تالف يسقط من الحساب. */
function dayStart(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(at) ? at : null;
}

const inWindow = (at: number, w: WeekWindow) => at >= w.from && at < w.to;

/**
 * مدى الأسبوع المنتهي عند `now`.
 *
 * سبعة أيام كاملة لا «من الأحد»: الملخص يُفتح في أي وقت، وأسبوعٌ يبدأ من
 * يومٍ ثابت يجعل فتحه صباح الإثنين يعرض ملخصًا فارغًا.
 */
export function weekEnding(now: number): WeekWindow {
  return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
}

/** أعلى قيمة بكسر تعادل ثابت على المفتاح، فالنتيجة لا تتبدّل بين نداءين. */
function pickTop<T>(rows: T[], value: (row: T) => number, key: (row: T) => string): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (value(row) <= 0) continue;
    if (
      best === null ||
      value(row) > value(best) ||
      (value(row) === value(best) && key(row) < key(best))
    ) {
      best = row;
    }
  }
  return best;
}

export function summariseWeek(input: WeekInput, window: WeekWindow): WeekSummary {
  const reads = (input.reads ?? []).filter((row) => inWindow(row.lastReadAt, window));
  const ratings = (input.ratings ?? []).filter((row) => inWindow(row.updatedAt, window));
  const days = (input.days ?? []).filter((row) => {
    const at = dayStart(row.day);
    return at !== null && inWindow(at, window);
  });

  const people: WeekPerson[] = input.accounts.map((account) => {
    const mine = reads.filter((row) => row.userId === account.userId);
    const perSeries = new Map<string, number>();
    for (const row of mine) perSeries.set(row.seriesRef, (perSeries.get(row.seriesRef) ?? 0) + 1);
    const top = pickTop(
      [...perSeries].map(([seriesRef, count]) => ({ seriesRef, count })),
      (row) => row.count,
      (row) => row.seriesRef,
    );
    return {
      userId: account.userId,
      displayName: account.displayName,
      chapters: mine.length,
      rereads: mine.filter((row) => row.readCount > 1).length,
      activeMs: days
        .filter((row) => row.userId === account.userId)
        .reduce((sum, row) => sum + Math.max(0, row.activeMs), 0),
      topSeries: top?.seriesRef ?? null,
    };
  });

  // الترتيب بالفصول تنازليًّا، والتعادل بالمعرّف — فالقائمة نفسها في كل فتح
  people.sort((a, b) => b.chapters - a.chapters || (a.userId < b.userId ? -1 : 1));

  const moments: WeekMoment[] = [];

  const mostRead = pickTop(people, (row) => row.chapters, (row) => row.userId);
  if (mostRead) moments.push({ kind: 'MOST_READ', userId: mostRead.userId, chapters: mostRead.chapters });

  const mostReread = pickTop(people, (row) => row.rereads, (row) => row.userId);
  if (mostReread) moments.push({ kind: 'MOST_REREAD', userId: mostReread.userId, rereads: mostReread.rereads });

  // «العمل الذي قرأه الجميع»: **كلُّ** حساب لا أغلبهم — ولا معنى له بحسابٍ واحد
  if (input.accounts.length > 1) {
    const readersOf = new Map<string, Set<string>>();
    for (const row of reads) {
      const readers = readersOf.get(row.seriesRef) ?? new Set<string>();
      readers.add(row.userId);
      readersOf.set(row.seriesRef, readers);
    }
    const shared = [...readersOf]
      .filter(([, readers]) => readers.size === input.accounts.length)
      .map(([seriesRef]) => seriesRef)
      .sort();
    if (shared.length > 0) moments.push({ kind: 'SHARED_WORK', seriesRef: shared[0]! });
  }

  const lowest = ratings.reduce<WeekRating | null>((worst, row) => {
    if (worst === null) return row;
    if (row.score < worst.score) return row;
    if (row.score === worst.score && `${row.userId}/${row.seriesRef}` < `${worst.userId}/${worst.seriesRef}`) {
      return row;
    }
    return worst;
  }, null);
  if (lowest) {
    moments.push({
      kind: 'LOWEST_RATING',
      userId: lowest.userId,
      seriesRef: lowest.seriesRef,
      score: lowest.score,
    });
  }

  return { from: window.from, to: window.to, people, moments };
}
