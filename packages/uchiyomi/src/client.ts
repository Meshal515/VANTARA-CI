import {
  type ChapterVersions,
  type SeriesListing,
  type AdminUser,
  type Book,
  type Chapter,
  type GroupedResult,
  type LoginResult,
  type Page,
  type ProgressUpdate,
  type SeriesSummary,
  type SourceInfo,
  type SourceProvider,
  type UchiyomiUser,
  UchiyomiError,
} from './types.ts';

export interface UchiyomiClientOptions {
  baseUrl: string;
  /** توكن خدمة `uy_…` بنطاق. يُستخدم لكل نداء لا يتصرف بهوية مستخدم. */
  serviceToken?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** توكن مستخدم يتجاوز توكن الخدمة، لنداء يجب أن يتصرف بهويته. */
  token?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** بعض المسارات تُرجع 404 كإجابة صحيحة (غير موجود) لا كخطأ. */
  allow404?: boolean;
  timeoutMs?: number;
  /**
   * تعطيل إعادة المحاولة. يلزم للمسارات ذات الميزانية المحدودة: تسجيل الدخول
   * عند Uchiyomi محدود المعدّل، وإعادة المحاولة تستهلك الميزانية بلا فائدة.
   */
  noRetry?: boolean;
}

/**
 * العميل الوحيد الذي يتكلم مع Uchiyomi.
 *
 * VANTARA لا يتكلم مع Suwayomi مباشرة (D-01) ولا يكتب تقدمًا من عنده (D-02):
 * `setProgress` هنا تمريرة إلى Uchiyomi، وليست كتابة في جداولنا.
 */
export class UchiyomiClient {
  readonly #baseUrl: string;
  readonly #serviceToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;

  constructor(options: UchiyomiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#serviceToken = options.serviceToken;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 2;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async #request<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const token = options.token ?? this.#serviceToken;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: unknown;
    const maxAttempts = options.noRetry ? 0 : this.#retries;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      // مهلة لكل محاولة على حدة، لا للعملية كلها
      const signal = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          method: options.method ?? 'GET',
          headers,
          signal,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });

        if (response.status === 404 && options.allow404) return undefined;

        if (!response.ok) {
          const detail = await this.#errorDetail(response);
          const error = new UchiyomiError(
            detail.message ?? `${response.status} on ${path}`,
            response.status,
            detail.code,
            path,
          );
          // 4xx حقيقة ثابتة: لا فائدة من إعادة المحاولة
          if (!error.retryable || attempt === maxAttempts) throw error;
          lastError = error;
        } else {
          if (response.status === 204) return undefined;
          return (await response.json()) as T;
        }
      } catch (err) {
        if (err instanceof UchiyomiError && !err.retryable) throw err;
        if (attempt === maxAttempts) throw err;
        lastError = err;
      }

      // تراجع أُسّي: 200ms, 400ms, 800ms …
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }

    throw lastError instanceof Error ? lastError : new Error(`request to ${path} failed`);
  }

  async #errorDetail(response: Response): Promise<{ code?: string; message?: string }> {
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      return {
        ...(body.error !== undefined ? { code: body.error } : {}),
        ...(body.message ?? body.error ? { message: body.message ?? body.error } : {}),
      };
    } catch {
      return {};
    }
  }

  /** يرمي إذا كانت الاستجابة فارغة — للمسارات التي يجب أن تُرجع جسمًا. */
  async #require<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const out = await this.#request<T>(path, options);
    if (out === undefined) throw new UchiyomiError(`empty response`, 502, undefined, path);
    return out;
  }

  // ───────────────────────── الصحة والمصادقة ─────────────────────────

  async healthy(): Promise<boolean> {
    try {
      await this.#request('/healthz', { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async needsSetup(): Promise<boolean> {
    const out = await this.#require<{ needsSetup: boolean }>('/api/setup/status');
    return out.needsSetup;
  }

  /**
   * تحقق من بيانات الدخول عند Uchiyomi. VANTARA لا يخزّن كلمات مرور ولا يتحقق منها.
   */
  login(username: string, password: string): Promise<LoginResult> {
    return this.#require<LoginResult>('/auth/login', {
      method: 'POST',
      body: { username, password },
      // Uchiyomi يحدّ معدّل هذا المسار؛ إعادة المحاولة تحرق الميزانية
      noRetry: true,
    });
  }

  me(token: string): Promise<UchiyomiUser> {
    return this.#require<UchiyomiUser>('/auth/me', { token });
  }

  /**
   * يصكّ توكن `uy_…` طويل العمر باسم صاحب `sessionToken`.
   *
   * هذا ما يعفي VANTARA من دورة refresh: توكن الجلسة عند Uchiyomi يعيش 900
   * ثانية، أما هذا فيعيش بعمر جلسة VANTARA. السرّ يُرجَع مرة واحدة فقط.
   */
  mintToken(
    sessionToken: string,
    options: { name: string; scopes: string[]; expiresInDays: number },
  ): Promise<{ id: string; token: string }> {
    return this.#require<{ id: string; token: string }>('/api/tokens', {
      method: 'POST',
      token: sessionToken,
      body: options,
      // إنشاء التوكن ليس idempotent. إذا أنشأه upstream ثم انقطع الرد، إعادة
      // POST تنشئ credential ثانيًا لا نعرف id حقه ويبقى صالحًا حتى انتهاءه.
      noRetry: true,
    });
  }

  async revokeToken(sessionToken: string, tokenId: string): Promise<void> {
    await this.#request(`/api/tokens/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
      token: sessionToken,
      allow404: true,
    });
  }

  listUsers(): Promise<AdminUser[]> {
    return this.#require<AdminUser[]>('/api/admin/users');
  }

  // ───────────────────────────── المصادر ─────────────────────────────

  async listSources(token?: string): Promise<SourceInfo[]> {
    const out = await this.#require<{ content: SourceInfo[] }>(
      '/api/sources',
      token !== undefined ? { token } : {},
    );
    return out.content;
  }

  /**
   * بحث عبر كل المصادر، مُجمّعًا بالعنوان مع `providers[]`.
   * هذا هو ما يجعل طبقة الهوية عندنا إثراءً لا بناءً — انظر RESULTS.md §3.
   */
  async searchAll(q: string, token?: string): Promise<GroupedResult[]> {
    const out = await this.#require<{ content: GroupedResult[] }>('/api/sources/search-all', {
      query: { q },
      timeoutMs: 120_000,
      ...(token !== undefined ? { token } : {}),
    });
    return out.content;
  }

  /** بحث مسطّح: صف لكل مصدر، بلا تجميع. */
  async find(q: string, token?: string): Promise<SourceProvider[]> {
    const out = await this.#require<{ content: SourceProvider[] }>('/api/sources/find', {
      query: { q },
      timeoutMs: 120_000,
      ...(token !== undefined ? { token } : {}),
    });
    return out.content;
  }

  /** ملاحظة: المعامل اسمه `sourceId` لا `id` — `id` يرجع 400. */
  sourceDetail(source: string, sourceId: string): Promise<SeriesSummary & { count: number }> {
    return this.#require<SeriesSummary & { count: number }>('/api/sources/detail', {
      query: { source, sourceId },
      timeoutMs: 120_000,
    });
  }

  testSource(sourceId: string, token?: string): Promise<unknown> {
    return this.#require(`/api/admin/sources/${encodeURIComponent(sourceId)}/test`, {
      method: 'POST',
      timeoutMs: 120_000,
      ...(token !== undefined ? { token } : {}),
    });
  }

  extensionStatus(token?: string): Promise<{
    configured: boolean;
    reachable: boolean;
    version: string;
    enabled: number;
    registered: number;
    cap: number;
  }> {
    return this.#require(
      '/api/admin/extensions/status',
      token !== undefined ? { token } : {},
    );
  }

  // ─────────────────────── الأعمال والفصول والصفحات ───────────────────

  series(id: string, token?: string): Promise<SeriesSummary | undefined> {
    return this.#request<SeriesSummary>(`/api/series/${encodeURIComponent(id)}`, {
      allow404: true,
      ...(token !== undefined ? { token } : {}),
    });
  }

  /**
   * الفصول التي يحملها الخادم، بترتيب القراءة.
   *
   * غير مُصفَّح عند upstream (لا page ولا size في العقد)، فالاستجابة كاملة —
   * وهذا مقصود: عمل بسبعمئة فصل يعيدها كلها.
   */
  async chapters(seriesId: string, token?: string): Promise<Chapter[]> {
    const out = await this.#require<{ content: Chapter[] }>(
      `/api/series/${encodeURIComponent(seriesId)}/books`,
      { timeoutMs: 90_000, ...(token !== undefined ? { token } : {}) },
    );
    return out.content;
  }

  /**
   * الأرقام التي يعرضها المصدر ولا يحملها الخادم، مع سبب غياب كل واحد.
   *
   * تُقرأ من آخر sweep لا من المصادر مباشرة، فـ`checkedAt` هو عمر الجواب.
   */
  async listing(seriesId: string, token?: string): Promise<SeriesListing> {
    const out = await this.#require<SeriesListing>(
      `/api/series/${encodeURIComponent(seriesId)}/listing`,
      { timeoutMs: 90_000, ...(token !== undefined ? { token } : {}) },
    );
    return { checkedAt: out.checkedAt ?? null, content: out.content ?? [] };
  }

  /**
   * صفحة واحدة من المكتبة.
   *
   * المسار مُصفَّح (`page`/`size`) وتجاهل ذلك يعني أن المكتبة تُعرض بصفحتها
   * الأولى فقط — نحو عشرين عملًا من آلاف. `searchLibraryAll` يستنفدها.
   */
  librarySearch(
    token: string,
    body: { query?: string; page?: number; size?: number; sort?: string } = {},
  ): Promise<{ content?: unknown[]; totalPages?: number; last?: boolean; totalElements?: number }> {
    return this.#require('/api/series/search', {
      method: 'POST',
      token,
      body,
      timeoutMs: 90_000,
    });
  }

  /**
   * نسخ كل رقم فصل من كل مصدر — ChapterVariant الجاهز.
   *
   * هذا هو أساس تعدّد المصادر: لكل رقم قائمة نسخ بعلامات `chosen` و`blocked`
   * و`onDisk`، و`source`+`sourceId` من هنا يصنعان Pick لـ`/api/sources/fetch`.
   * فمصدر ساقط لا يُخفي الفصل — تُجلب نسخة أخرى.
   *
   * المهلة أوسع: الاستجابة تحمل كل الأرقام بكل نسخها، وهي كبيرة لعمل طويل.
   */
  async versions(seriesId: string, token?: string): Promise<ChapterVersions> {
    const out = await this.#require<ChapterVersions>(
      `/api/series/${encodeURIComponent(seriesId)}/versions`,
      { timeoutMs: 90_000, ...(token !== undefined ? { token } : {}) },
    );
    return { checkedAt: out.checkedAt ?? null, content: out.content ?? [] };
  }

  /**
   * قائمة صفحات الفصل.
   *
   * upstream يرجع **مصفوفة مجرّدة** لا `{ content }` كبقية المسارات، وقراءتها
   * على أنها `{ content }` تعطي صفر صفحات بصمت. نتحمّل الشكلين.
   */
  async pages(bookId: string, token?: string): Promise<Page[]> {
    const out = await this.#require<Page[] | { content: Page[] }>(
      `/api/books/${encodeURIComponent(bookId)}/pages`,
      token !== undefined ? { token } : {},
    );
    return Array.isArray(out) ? out : out.content;
  }

  book(bookId: string, token?: string): Promise<Book | undefined> {
    return this.#request<Book>(`/api/books/${encodeURIComponent(bookId)}`, {
      allow404: true,
      ...(token !== undefined ? { token } : {}),
    });
  }

  /**
   * التقدم يُكتب هنا وهنا فقط (D-02). التوكن إلزامي: التقدم ملك مستخدم بعينه،
   * ولا يُكتب بتوكن خدمة.
   */
  async setProgress(bookId: string, token: string, update: ProgressUpdate): Promise<void> {
    await this.#request(`/api/books/${encodeURIComponent(bookId)}/progress`, {
      method: 'PUT',
      token,
      body: update,
    });
  }

  history(token: string): Promise<unknown> {
    return this.#require('/api/history', { token });
  }

  stats(token: string): Promise<unknown> {
    return this.#require('/api/stats', { token });
  }

  rating(seriesId: string, token: string, value: number): Promise<unknown> {
    return this.#require(`/api/ratings/${encodeURIComponent(seriesId)}`, {
      method: 'PUT',
      token,
      body: { rating: value },
    });
  }

  /** عنوان صورة الصفحة. `pageNumber` 1-based. تُقدَّم عبر vantara-api. */
  pageImageUrl(bookId: string, pageNumber: number, maxWidth?: number): string {
    const url = new URL(
      `${this.#baseUrl}/img/books/${encodeURIComponent(bookId)}/page/${String(pageNumber)}`,
    );
    if (maxWidth !== undefined) url.searchParams.set('maxWidth', String(maxWidth));
    return url.toString();
  }
}
