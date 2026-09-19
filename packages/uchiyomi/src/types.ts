/** أنواع Uchiyomi REST المستخدمة فعليًا، مشتقة من openapi.yaml v0.34. */

export interface UchiyomiUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  totpEnabled: boolean;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: UchiyomiUser;
  refreshExpiresAt: number;
}

export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  disabled: boolean;
  max_age_rating: number | null;
  last_active: string | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  lang: string;
  extension: string | null;
  status: string;
  /** غير null ⇒ المصدر معاقب مؤقتًا ولا يُسأل */
  blockedUntil: string | null;
  note: string | null;
}

export interface SourceProvider {
  source: string;
  name: string;
  sourceId: string;
  title: string;
  coverUrl: string | null;
}

/**
 * نتيجة بحث مُجمّعة بالعنوان عبر عدة مصادر.
 * التجميع يجري في Uchiyomi، لا عندنا — انظر D-01.
 */
export interface GroupedResult {
  title: string;
  coverUrl: string | null;
  providers: SourceProvider[];
  inLibrary: boolean;
}

export interface SeriesSource {
  /** Adapter id, e.g. the source registered in Uchiyomi. */
  sourceId: string;
  /** This series' id inside that adapter/source. */
  sourceSeriesId: string;
  name?: string;
  primary?: boolean;
  registered?: boolean;
}

export interface SeriesSummary {
  id: string;
  title: string;
  summary?: string;
  coverUrl?: string | null;
  genres?: string[];
  status?: string;
  /** Exact source identities attached to the canonical Uchiyomi series. */
  sources?: SeriesSource[];
}

export interface Chapter {
  id: string;
  name?: string;
  number?: number;
  scanlator?: string | null;
  read?: boolean;
}

export interface Page {
  /** 1-based. الفهرس 0 يرجع 502 من upstream. */
  number: number;
  fileName?: string;
  mediaType?: string;
  /** الأبعاد المخزّنة: تسمح بصندوق بنسبة أبعاد دقيقة ⇒ صفر قفزة تخطيط. */
  width?: number | null;
  height?: number | null;
}

export interface Book {
  id: string;
  seriesId: string;
  seriesTitle?: string;
  name?: string;
  number?: number;
  media?: { pagesCount?: number; mediaType?: string; status?: string };
  readProgress?: { page?: number; completed?: boolean } | null;
}

export interface ProgressUpdate {
  page?: number | undefined;
  completed?: boolean | undefined;
}

export class UchiyomiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly path: string;

  // حقول صريحة لا parameter properties: strip-only mode في Node لا يدعمها
  constructor(message: string, status: number, code: string | undefined, path: string) {
    super(message);
    this.name = 'UchiyomiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }

  /** الأخطاء العابرة: تستحق إعادة محاولة، بخلاف 4xx. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status >= 503;
  }
}

/**
 * نسخة واحدة من رقم فصل عند مصدر، من `/api/series/{id}/versions`.
 *
 * `pages: 0` رابط خارجي لا يُنزَّل، و`null` يعني أن المصدر لا يقول — والفرق
 * مهم: الأول يُستبعد من الاختيار والثاني لا.
 */
export interface Copy {
  /** `<source>:<sourceId>`، فريد داخل الرقم. */
  key: string;
  source: string;
  sourceName: string;
  groups: string[];
  scanlator: string | null;
  lang: string | null;
  pages: number | null;
  publishedAt: string | null;
  chosen: boolean;
  blocked: boolean;
  onDisk: boolean;
}

export interface ChapterVersions {
  checkedAt: string | null;
  content: { number: number; copies: Copy[] }[];
}

/**
 * رقم فصل يعرضه المصدر ولا يحمل الخادم صفًّا له، من `/api/series/{id}/listing`.
 *
 * `why` هو ما يفرّق بين عطل وقرار: `floor` يعني أرضية «آخر N فصلًا»
 * و`blocked` مجموعة محجوبة، وكلاهما مقصود — بخلاف `missing` و`failed`.
 */
export interface Ghost {
  number: number;
  title: string | null;
  publishedAt: string | null;
  scanlator: string | null;
  groups: string[];
  sourceId: string;
  sourceName: string;
  why: 'missing' | 'held' | 'blocked' | 'failed' | 'floor';
  attempts?: number;
  waitingFor?: string;
  waitDaysLeft?: number;
}

export interface SeriesListing {
  checkedAt: string | null;
  content: Ghost[];
}
