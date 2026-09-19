/**
 * حكم المصدر: لا يُوصف مصدر بأنه مدعوم بلا دليل.
 *
 * المعيار الخمسي مأخوذ من الـspike، حيث ثبت أن مصدرًا يمكن أن ينجح في البحث
 * ويفشل في الفصول (Mangalek: Cloudflare)، وأن مصدرًا يمكن أن يكون حيًّا تمامًا
 * وبحثه غير صالح (Team X و3asq).
 */

export type SourceVerdict =
  | 'REGISTERED_NOT_TESTED'
  | 'SUPPORTED'
  | 'SEARCH_BROKEN'
  | 'NEEDS_FLARESOLVERR'
  | 'PARSER_FAILED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'POLICY_BLOCKED';

/** محاولة بحث واحدة باستعلام واحد. */
export interface SearchAttempt {
  query: string;
  ok: boolean;
  count?: number;
  relevant?: boolean;
  error?: string;
}

export interface ProbeEvidence {
  /** قائمة الأكثر شعبية ترجع عناصر ⇒ المصدر حيّ. */
  popular: { ok: boolean; count?: number; error?: string };
  /** البحث يرجع نتائج **ذات صلة** بالاستعلام، لا مجرد نتائج. */
  search: { ok: boolean; count?: number; relevant?: boolean; error?: string };
  /**
   * محاولات بحث متعددة.
   *
   * قِيس أن المصدر يستجيب لاستعلام ويرمي على آخر: Kawii Manga خدم
   * `nano machine` ورمى على `the`، ثلاث جولات متطابقة. فحكم البحث من استعلام
   * واحد غير صالح، وهذا الحقل يجعله من مجموعة.
   */
  searchAttempts?: SearchAttempt[];
  /** الاستعلام الذي وجد العمل، والعمل نفسه: بدونهما الأعداد بلا معنى. */
  probeQuery?: string;
  probedWork?: string;
  chapters: { ok: boolean; count?: number; error?: string };
  /** فصل قديم وفصل حديث: الفصل الأول قد يعمل والأحدث لا. */
  pagesOldest: { ok: boolean; count?: number; error?: string };
  pagesNewest: { ok: boolean; count?: number; error?: string };
  /** الصور فُكّ ترميزها فعلًا، لا Content-Type فقط. */
  imagesDecoded: { ok: boolean; types?: string[]; error?: string };
}

const CLOUDFLARE_MARKERS = [
  'cloudflare bypass currently disabled',
  'cloudflare',
  'flaresolverr',
  'challenge',
];

function mentionsCloudflare(evidence: ProbeEvidence): boolean {
  const errors = [
    evidence.popular.error,
    evidence.search.error,
    evidence.chapters.error,
    evidence.pagesOldest.error,
    evidence.pagesNewest.error,
  ]
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.toLowerCase());

  return errors.some((error) => CLOUDFLARE_MARKERS.some((marker) => error.includes(marker)));
}

/**
 * صلاحية البحث من كل المحاولات، لا من واحدة.
 *
 * `partial` هي الحالة التي كشفها القياس: Kawii Manga خدم `nano machine` ورمى
 * على `the`، ثلاث جولات متطابقة. حكمها من استعلام واحد يقلبها بين
 * `SUPPORTED` و`PARSER_FAILED` بحسب أي استعلام جرّبناه — وهذا عيب في الفحص
 * لا في المصدر.
 */
export function searchUsability(evidence: ProbeEvidence): 'usable' | 'partial' | 'unusable' {
  const attempts = evidence.searchAttempts;

  if (attempts === undefined || attempts.length === 0) {
    return evidence.search.ok && evidence.search.relevant === true ? 'usable' : 'unusable';
  }

  const relevant = attempts.filter((a) => a.ok && a.relevant === true).length;
  if (relevant === 0) return 'unusable';
  return relevant === attempts.length ? 'usable' : 'partial';
}

/**
 * الحكم من الدليل. الترتيب مقصود: Cloudflare يُشخّص قبل PARSER_FAILED لأنه
 * قابل للإصلاح بتشغيل FlareSolverr، بخلاف parser مكسور.
 */
export function verdictFrom(evidence: ProbeEvidence): SourceVerdict {
  if (mentionsCloudflare(evidence)) return 'NEEDS_FLARESOLVERR';

  const alive = evidence.popular.ok || evidence.search.ok;
  if (!alive) return 'PARSER_FAILED';

  // حيّ، لكن البحث لا يُوصل إلى العمل ⇒ الاكتشاف يمر بـPOPULAR/LATEST + مطابقة عنوان
  if (searchUsability(evidence) === 'unusable') return 'SEARCH_BROKEN';

  if (!evidence.chapters.ok) return 'PARSER_FAILED';
  if (!evidence.pagesOldest.ok || !evidence.pagesNewest.ok) return 'PARSER_FAILED';
  if (!evidence.imagesDecoded.ok) return 'PARSER_FAILED';

  return 'SUPPORTED';
}

/** المصادر التي يجوز للقارئ الذكي أن يسحب منها فصلًا. */
export function usableForReading(verdict: SourceVerdict): boolean {
  return verdict === 'SUPPORTED' || verdict === 'SEARCH_BROKEN';
}

/** المصادر التي يجوز أن تُستخدم لاكتشاف عمل جديد عبر البحث. */
export function usableForSearch(verdict: SourceVerdict): boolean {
  return verdict === 'SUPPORTED';
}

export type PublicSourceHealth = 'healthy' | 'limited' | 'checking' | 'unavailable' | 'blocked';

export interface PublicSourceContract {
  id: string;
  name: string;
  language: string | null;
  health: PublicSourceHealth;
  capabilities: {
    search: boolean;
    read: boolean;
  };
}

/**
 * العقد الذي تراه الواجهة. التشخيص الداخلي يبقى في evidence/probes ولا يتسرب
 * إلى كل Card/صف فصل.
 */
export function toPublicSource(input: {
  id: string;
  name: string;
  lang?: string | null;
  verdict: SourceVerdict;
}): PublicSourceContract {
  let health: PublicSourceHealth;
  switch (input.verdict) {
    case 'SUPPORTED':
      health = 'healthy';
      break;
    case 'SEARCH_BROKEN':
      health = 'limited';
      break;
    case 'REGISTERED_NOT_TESTED':
      health = 'checking';
      break;
    case 'POLICY_BLOCKED':
      health = 'blocked';
      break;
    case 'NEEDS_FLARESOLVERR':
    case 'TEMPORARILY_UNAVAILABLE':
    case 'PARSER_FAILED':
      health = 'unavailable';
      break;
  }

  return {
    id: input.id,
    name: input.name,
    language: input.lang ?? null,
    health,
    capabilities: {
      search: usableForSearch(input.verdict),
      read: usableForReading(input.verdict),
    },
  };
}

/**
 * هل يُعدّ البحث ذا صلة؟
 *
 * الـspike أظهر أن Team X يرجع 11 نتيجة لا علاقة لها بالاستعلام، فمجرد وجود
 * نتائج ليس نجاحًا. نطلب تطابقًا جزئيًا بين الاستعلام وأحد العناوين.
 */
export function looksRelevant(query: string, titles: readonly string[]): boolean {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[ً-ْ]/g, '') // تشكيل عربي
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  const needle = normalise(query);
  if (needle.length === 0) return false;

  const terms = needle.split(' ').filter((t) => t.length >= 3);
  if (terms.length === 0) return titles.some((t) => normalise(t).includes(needle));

  return titles.some((title) => {
    const hay = normalise(title);
    return terms.every((term) => hay.includes(term));
  });
}
