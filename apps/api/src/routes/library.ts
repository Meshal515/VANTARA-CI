import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '@vantara/db';
import { UchiyomiError } from '@vantara/uchiyomi';
import {
  auditCoverage,
  buildCatalogue,
  ownerOf,
  pickCopy,
  type ChapterCopy,
} from '@vantara/domain';
import { requireSession, sessionOf, type AppContext } from '../lib/context.ts';
import { maxWidthSuffix, streamUpstreamImage } from '../lib/images.ts';

interface SeriesRow {
  id: string;
  name: string;
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  source?: string | null;
  color?: string | null;
  metadata?: { summary?: string; status?: string; genres?: string[] } | null;
}

interface ChapterFallbackOptions {
  copies: readonly ChapterCopy[];
  fetchCopy: (copy: ChapterCopy | null) => Promise<unknown>;
  verifyAvailable: (copy: ChapterCopy | null) => Promise<boolean>;
  /** أقصى زمن للمحاولات مجتمعة. انظر `CHAPTER_FALLBACK_BUDGET_MS`. */
  budgetMs?: number;
  /** للاختبار: ساعة قابلة للتحكم بدل انتظار حقيقي. */
  now?: () => number;
}

/**
 * ميزانية الجلب كاملةً، لا لكل نسخة.
 *
 * VANTARA خلف Cloudflare Tunnel، وCloudflare يقطع الطلب عند **100 ثانية**
 * (‏524). فبلا سقف هنا، عملٌ بخمس نسخ مكسورة يعني طلبًا يعيش دقائق: القارئ
 * يرى خطأ شبكة غامضًا بدل `chapter_unavailable` الواضح، والخادم يواصل الطحن
 * لأحد انصرف. السقف دون الـ100 بهامش يكفي لإرسال جواب مفهوم.
 */
const CHAPTER_FALLBACK_BUDGET_MS = 75_000;

interface ChapterFallbackResult {
  chosen: string | null;
  attempts: number;
}

class ChapterUnavailableError extends Error {
  readonly code = 'chapter_unavailable';
  readonly attempts: number;

  constructor(attempts: number) {
    super('chapter_unavailable');
    this.name = 'ChapterUnavailableError';
    this.attempts = attempts;
  }
}

/**
 * يجرب نسخ الفصل داخل الخادم حتى تثبت إتاحة واحدة فعلًا.
 *
 * نجاح `/api/sources/fetch` وحده ليس نجاح قراءة: upstream قد يقبل المهمة ثم
 * لا ينتج فصلًا. لذلك لا ننتقل للنسخة التالية إلا بعد `verifyAvailable`، ولا
 * نعيد نجاحًا للعميل إلا عندما يصبح الفصل قابلًا للفتح.
 */
export async function fetchChapterWithFallback(
  options: ChapterFallbackOptions,
): Promise<ChapterFallbackResult> {
  let attempts = 0;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? CHAPTER_FALLBACK_BUDGET_MS;
  const startedAt = now();
  const spent = () => now() - startedAt;

  // لا metadata: دع upstream يجرب اختياره التلقائي مرة واحدة فقط.
  if (options.copies.length === 0) {
    attempts = 1;
    try {
      await options.fetchCopy(null);
      if (await options.verifyAvailable(null)) return { chosen: null, attempts };
    } catch {
      // الخطأ النهائي موحّد أدناه؛ التفاصيل التقنية لا تتسرب للواجهة.
    }
    throw new ChapterUnavailableError(attempts);
  }

  const exclude = new Set<string>();
  while (exclude.size < options.copies.length) {
    // الميزانية تُفحص **قبل** بدء محاولة، لا بعدها: محاولة تبدأ بثانية متبقية
    // تنتهي بعد انقطاع العميل، فتكلّف المصدر عملًا لا يقرأه أحد.
    if (attempts > 0 && spent() >= budgetMs) break;

    const copy = pickCopy(options.copies, { exclude });
    if (!copy) break;
    exclude.add(copy.key);
    attempts += 1;

    try {
      await options.fetchCopy(copy);
      if (await options.verifyAvailable(copy)) {
        return { chosen: copy.key, attempts };
      }
    } catch {
      // المصدر/النسخة فشلت: جرّب التالية داخل نفس الطلب.
    }
  }

  throw new ChapterUnavailableError(attempts);
}

/** الصور تُقدَّم عبر VANTARA لا مباشرة: المتصفح يحمل كوكي مبهمًا، والتوكن عندنا. */
const IMAGE_KINDS = ['series-thumb', 'series-backdrop', 'book-thumb', 'page'] as const;
type ImageKind = (typeof IMAGE_KINDS)[number];

export async function libraryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const base = ctx.config.UCHIYOMI_URL.replace(/\/+$/, '');

  /**
   * كل الأعمال المتابَعة، بعد حجب المحذوف للجميع.
   *
   * يستنفد الصفحات. `/api/series/search` مُصفَّح (`page`/`size`) وكان يُنادى
   * بجسم فارغ، فكانت المكتبة تُعرض بصفحتها الأولى وحدها — نحو عشرين عملًا
   * من آلاف، بلا أي خطأ يشير إلى النقص.
   *
   * التوقّف على ثلاث علامات معًا (`last`، `totalPages`، صفحة أقصر من المقاس)
   * لأن أيها يكفي، وغيابها كلها يعني حلقة لا تنتهي. والتخلّص من التكرار
   * بالمعرّف يجعل الحلقة صحيحة سواء كان الترقيم من صفر أو من واحد.
   */
  const PAGE_SIZE = 200;
  const MAX_PAGES = 80;

  const allSeries = async (token: string): Promise<SeriesRow[]> => {
    const seen = new Map<string, SeriesRow>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = await ctx.uchiyomi.librarySearch(token, {
        page,
        size: PAGE_SIZE,
        sort: 'updated,desc',
      });
      const rows = (payload.content ?? []) as SeriesRow[];
      for (const row of rows) if (row?.id) seen.set(row.id, row);
      if (rows.length < PAGE_SIZE) break;
      if (payload.last === true) break;
      if (payload.totalPages !== undefined && page + 1 >= payload.totalPages) break;
    }
    return [...seen.values()];
  };

  app.get('/v1/library', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const session = sessionOf(request);

    let series: SeriesRow[];
    try {
      series = await allSeries(session.token);
    } catch {
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }

    const deleted = new Set(
      (
        await query<{ series_ref: string }>(
          `SELECT series_ref FROM vantara_deleted_works WHERE restored_at IS NULL`,
        )
      ).map((row) => row.series_ref),
    );

    return reply.send({
      content: series
        .filter((row) => !deleted.has(row.id))
        .map((row) => ({
          id: row.id,
          title: row.name,
          chapters: row.booksCount,
          unread: row.booksUnreadCount,
          inProgress: row.booksInProgressCount,
          accent: row.color ?? null,
          summary: row.metadata?.summary ?? null,
          status: row.metadata?.status ?? null,
        })),
    });
  });

  app.get('/v1/series/:id', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);

    const deleted = await query<{ series_ref: string }>(
      `SELECT series_ref FROM vantara_deleted_works
        WHERE series_ref = $1 AND restored_at IS NULL`,
      [id],
    );
    // المحذوف للجميع يختفي من كل مسار، لا من البحث وحده
    if (deleted.length > 0) return reply.code(404).send({ error: 'not_found' });

    try {
      const [series, chapters] = await Promise.all([
        ctx.uchiyomi.series(id, session.token),
        ctx.uchiyomi.chapters(id, session.token).catch(() => []),
      ]);
      if (!series) return reply.code(404).send({ error: 'not_found' });
      return reply.send({ series, chapters });
    } catch (err) {
      if (err instanceof UchiyomiError && err.status === 404) {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    }
  });

  /**
   * الفصول التي يعرضها المصدر ولم تُجلب بعد.
   *
   * العمل يُضاف بلا تنزيل (`chapterFrom: none`)، فقائمة المصدر هي كل ما نعرفه
   * عنه في البداية. بدون هذا المسار تبدو المكتبة فارغة وهي ليست كذلك.
   */
  app.get('/v1/series/:id/listing', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);

    let listing;
    try {
      listing = await ctx.uchiyomi.listing(id, session.token);
    } catch {
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }

    // لا قطع. كان هنا `.slice(0, 400)` بعد ترتيب تنازلي، فكان عمل بسبعمئة
    // فصل يفقد أقدم ثلاثمئة — وهذا بالضبط ما يُرى كـ«الفصول تبدأ من 300».
    // و`why` يُمرَّر كما هو: الفراغ بسبب أرضية «آخر N فصلًا» ليس عطلًا،
    // وإخفاء السبب يجعله غامضًا.
    return reply.send({
      checkedAt: listing.checkedAt,
      content: [...listing.content].sort((a, b) => b.number - a.number),
    });
  });

  /**
   * نسخ كل رقم فصل من كل مصدر.
   *
   * هذا هو أساس تعدّد المصادر، وكان جاهزًا عند upstream وغير مستعمل: لكل رقم
   * كل النسخ بعلامات `chosen` و`blocked` و`onDisk`، فالتبديل بين المصادر
   * اختيار نسخة، ومصدر ساقط لا يُخفي الفصل.
   */
  app.get('/v1/series/:id/versions', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const versions = await ctx.uchiyomi.versions(id, sessionOf(request).token);
      return reply.send(versions);
    } catch (err) {
      if (err instanceof UchiyomiError && err.status === 404) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }
  });

  /**
   * يجلب فصلًا واحدًا، ويبدّل المصادر داخل الخادم حتى تصبح نسخة متاحة فعلًا.
   */
  app.post(
    '/v1/series/:id/chapters/:number/fetch',
    { preHandler: requireSession(ctx) },
    async (request, reply) => {
      const { id, number } = request.params as { id: string; number: string };
      // `exclude` القديم يُقبل للتوافق فقط؛ قرار الـfallback لم يعد عند العميل.
      const parsed = z
        .object({ exclude: z.array(z.string().max(300)).max(50).optional() })
        .safeParse(request.body ?? {});
      const target = Number(number);
      if (!parsed.success || !Number.isFinite(target)) {
        return reply.code(400).send({ error: 'bad_request' });
      }

      const session = sessionOf(request);
      const versions = await ctx.uchiyomi
        .versions(id, session.token)
        .catch(() => ({ checkedAt: null, content: [] }));
      const copies =
        versions.content.find((row) => Math.round(row.number * 100) === Math.round(target * 100))
          ?.copies ?? [];

      const deadline = Date.now() + CHAPTER_FALLBACK_BUDGET_MS;
      let resolvedBookId: string | null = null;
      const verifyAvailable = async (): Promise<boolean> => {
        // upstream يصف الجلب كعملية قد تتأخر؛ الانتظار هنا جزء من عقد الخادم
        // بدل أن يكرره كل عميل بقواعد مختلفة.
        for (const waitMs of [400, 900, 1_800]) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          const held = await ctx.uchiyomi.chapters(id, session.token).catch(() => []);
          const found = held.find(
            (chapter) =>
              Number.isFinite(chapter.number) &&
              Math.round((chapter.number as number) * 100) === Math.round(target * 100),
          );
          if (found?.id) {
            resolvedBookId = found.id;
            return true;
          }
        }
        return false;
      };

      try {
        const result = await fetchChapterWithFallback({
          copies,
          fetchCopy: async (copy) => {
            const body = copy
              ? {
                  seriesId: id,
                  picks: [
                    {
                      number: target,
                      source: copy.source,
                      sourceId: copy.key.slice(copy.source.length + 1),
                    },
                  ],
                }
              : { seriesId: id, numbers: [target] };

            // مهلة النداء الواحد = ما تبقّى من الميزانية، لا 180 ثانية ثابتة:
            // مهلة أطول من عمر الطلب نفسه تعني انتظارًا لجواب لن يُقرأ.
            const remaining = Math.max(1_000, deadline - Date.now());
            const response = await fetch(`${base}/api/sources/fetch`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(remaining),
            });
            if (!response.ok) throw new Error(`upstream_fetch_${String(response.status)}`);
          },
          verifyAvailable: async () => verifyAvailable(),
        });

        return reply.send({
          chosen: result.chosen,
          attempts: result.attempts,
          bookId: resolvedBookId,
        });
      } catch (error) {
        if (error instanceof ChapterUnavailableError) {
          return reply
            .code(503)
            .send({ error: error.code, attempts: error.attempts });
        }
        throw error;
      }
    },
  );

  /**
   * الفهرس الكامل: كل رقم فصل مرة واحدة، بحالته ونسخه، مع تقرير تغطية.
   *
   * ثلاثة مسارات منفصلة كانت تُدمج في العميل، وكل عميل يدمجها بطريقته. هنا
   * تُدمج مرة بقواعد مُختبرة (`@vantara/domain/chapters`)، ويُرفق `coverage`
   * الذي يسمّي الأرقام الغائبة صراحةً — «أظن أنها كاملة» ليست إجابة.
   *
   * الأشباح والنسخ تُجلب بتساهل: sweep متأخر أو مصدر ساقط يُنقص المعلومات
   * ولا يُفرّغ القائمة. الفصول المحمولة وحدها إلزامية.
   */
  app.get('/v1/series/:id/chapters', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);

    const deleted = await query<{ series_ref: string }>(
      `SELECT series_ref FROM vantara_deleted_works
        WHERE series_ref = $1 AND restored_at IS NULL`,
      [id],
    );
    if (deleted.length > 0) return reply.code(404).send({ error: 'not_found' });

    let held;
    try {
      held = await ctx.uchiyomi.chapters(id, session.token);
    } catch (err) {
      if (err instanceof UchiyomiError && err.status === 404) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }

    const [listing, versions] = await Promise.all([
      ctx.uchiyomi.listing(id, session.token).catch(() => ({ checkedAt: null, content: [] })),
      ctx.uchiyomi.versions(id, session.token).catch(() => ({ checkedAt: null, content: [] })),
    ]);

    const catalogue = buildCatalogue({
      held: held
        .filter((chapter) => Number.isFinite(chapter.number))
        .map((chapter) => ({
          id: chapter.id,
          number: chapter.number as number,
          name: chapter.name ?? null,
          read: chapter.read ?? false,
        })),
      ghosts: listing.content,
      versions: versions.content,
    });

    return reply.send({
      checkedAt: listing.checkedAt,
      content: catalogue,
      coverage: auditCoverage(catalogue),
    });
  });

  /**
   * يجلب فصولًا محددة عند الطلب.
   *
   * القراءة عند الطلب لا مرآة دائمة: نجلب ما يُقرأ الآن، لا الفصول الـ332.
   */
  app.post('/v1/series/:id/fetch', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // `picks` تسمّي نسخة بعينها من `/versions`، وهي ما يجعل «بدّل المصدر»
    // ممكنًا: العقد يقول إن الاختيار الصريح يتجاوز قواعد المجموعات والحجب.
    // والسقف 300 مجتمعة عند upstream؛ الخمسة السابقة كانت تمنع ملء فجوة
    // طويلة في طلب واحد بلا سبب.
    const parsed = z
      .object({
        numbers: z.array(z.number().min(0).max(1_000_000)).max(300).optional(),
        picks: z
          .array(z.object({ number: z.number(), source: z.string(), sourceId: z.string() }))
          .max(300)
          .optional(),
      })
      .refine(
        (body) => (body.numbers?.length ?? 0) + (body.picks?.length ?? 0) > 0,
        'numbers or picks required',
      )
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    const response = await fetch(`${base}/api/sources/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        seriesId: id,
        ...(parsed.data.numbers ? { numbers: parsed.data.numbers } : {}),
        ...(parsed.data.picks ? { picks: parsed.data.picks } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      return reply.code(response.status === 404 ? 404 : 502).send({ error: 'fetch_failed', detail: payload });
    }
    return reply.send(payload);
  });

  /**
   * صفحات الفصل، مع موضع القراءة السابق.
   *
   * الأبعاد تأتي من upstream فيبني القارئ صندوقًا بنسبة أبعاد دقيقة لكل صفحة
   * قبل تحميلها — وهذا ما يمنع قفزة التخطيط في شرائح الويبتون الطويلة.
   */
  app.get('/v1/books/:id/pages', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);

    const [pages, book] = await Promise.all([
      ctx.uchiyomi.pages(id, session.token),
      ctx.uchiyomi.book(id, session.token).catch(() => undefined),
    ]);

    if (pages.length === 0) return reply.code(404).send({ error: 'no_pages' });

    return reply.send({
      content: pages.map((page) => ({
        number: page.number,
        width: page.width ?? null,
        height: page.height ?? null,
      })),
      pagesCount: book?.media?.pagesCount ?? pages.length,
      resumeAt: book?.readProgress?.page ?? null,
      completed: book?.readProgress?.completed ?? false,
    });
  });

  /**
   * تقدم المالك لفصل واحد.
   *
   * يلزم لتصريف صندوق التقدم الصادر: العميل يحتاج قيمة المالك ليعرف هل مرآته
   * متقدمة فعلًا قبل أن يكتب. بلا مسار خفيف كهذا كان البديل جلب كل صفحات الفصل
   * لقراءة رقم واحد. لا نسخة ثانية هنا — تمريرة قراءة من المالك.
   */
  app.get('/v1/books/:id/progress', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionOf(request);
    try {
      const book = await ctx.uchiyomi.book(id, session.token);
      if (!book) return reply.code(404).send({ error: 'not_found' });
      return reply.send({
        owner: ownerOf('reading.progress'),
        page: book.readProgress?.page ?? 0,
        completed: book.readProgress?.completed ?? false,
      });
    } catch (err) {
      if (err instanceof UchiyomiError && err.status === 404) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // 404 يسمح للعميل بإسقاط صف outbox نهائيًا؛ لا يجوز تحويل outage
      // مؤقت إلى «الفصل غير موجود» وإقرار مرآة لم يرها المالك.
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }
  });

  /** التقدم يُكتب عند Uchiyomi وحده (D-02) — هذا تمريرة لا كتابة. */
  app.put('/v1/books/:id/progress', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({ page: z.number().int().min(0).optional(), completed: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    await ctx.uchiyomi.setProgress(id, session.token, parsed.data);
    return reply.code(204).send();
  });

  /**
   * بروكسي الصور بجلسة المستخدم.
   *
   * النقل نفسه في `lib/images.ts` لأن المسار الموقَّع (`/v1/media/page/*`)
   * يشاركه: الفرق بينهما من يُصرَّح له، لا كيف تُنقل البايتات.
   */
  const streamImage = async (
    reply: FastifyReply,
    token: string,
    path: string,
  ): Promise<FastifyReply> => streamUpstreamImage({ reply, base, token, path });

  app.get('/v1/img/:kind/:id', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!IMAGE_KINDS.includes(kind as ImageKind)) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    const session = sessionOf(request);
    const encoded = encodeURIComponent(id);
    const suffix = maxWidthSuffix((request.query as { maxWidth?: string }).maxWidth);

    const paths: Record<ImageKind, string> = {
      'series-thumb': `/img/series/${encoded}/thumb`,
      'series-backdrop': `/img/series/${encoded}/backdrop`,
      'book-thumb': `/img/books/${encoded}/thumb`,
      page: '',
    };

    if (kind === 'page') return reply.code(400).send({ error: 'use /v1/img/page/:id/:n' });
    return streamImage(reply, session.token, paths[kind as ImageKind] + suffix);
  });

  app.get('/v1/img/page/:id/:n', { preHandler: requireSession(ctx) }, async (request, reply) => {
    const { id, n } = request.params as { id: string; n: string };
    const index = z.coerce.number().int().min(0).max(10_000).safeParse(n);
    if (!index.success) return reply.code(400).send({ error: 'bad_request' });

    const session = sessionOf(request);
    const suffix = maxWidthSuffix((request.query as { maxWidth?: string }).maxWidth);
    return streamImage(
      reply,
      session.token,
      `/img/books/${encodeURIComponent(id)}/page/${String(index.data)}${suffix}`,
    );
  });
}
